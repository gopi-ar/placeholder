const _ = require('lodash');
const { arrayParam, sortingAlgorithm, mapResult, rowsToIdMap, getParentIds } = require('./_util');
const debug = false;
const PARTIAL_TOKEN_SUFFIX = require('../../lib/analysis').PARTIAL_TOKEN_SUFFIX;

module.exports = function( req, res ){

  // placeholder
  var ph = req.app.locals.ph;

  // placetype filter
  var filter = { placetype: arrayParam( req.query.placetype ) };

  // input validation
  let params = ['address', 'city', 'state', 'country', 'postal_code', 'text', 'limit'];
  let input = {};
  params.map((p) => { 
    input[p] = (req.query[p] || '').replace(/[-֊־‐‑﹣\/\(\)\[\]]/g, ' ').replace(/['`‘“”’/]/g, '').trim();
  });

  // live mode (autocomplete-style search)
  if( req.query.mode === 'live' && input.text){
    input.text += PARTIAL_TOKEN_SUFFIX;
    input.limit = (input.limit > 0) ? input.limit : 5;
  }

  // Get only one match - by default
  input.limit = (input.limit > 1) ? input.limit : 1;
  input.minimal = (Number.parseInt(req.query.minimal) > 0) ? true : false;

  // The search text
  let text;

  // language property
  var lang;
  if( 'string' === typeof req.query.lang && req.query.lang.length === 3 ){
    lang = req.query.lang.toLowerCase();
  }

  // If we have lat / lon, remove all other inputs
  input.lat = ((req.query.lat || '').length > 0) ? _.toNumber(req.query.lat) : '';
  input.lon = ((req.query.lon || '').length > 0) ? _.toNumber(req.query.lon) : '';
   if (isValidLatLon(input.lat, input.lon)) {
     params.map((p) => {
       if (p !== 'lat' && p !== 'lon' && p !== 'limit' && p !== 'minimal') { input[p] = ''; }
     });
     if (debug) { console.info('Matching Geo: ' + input.lat + ' ' + input.lon); }
    // Find nearest place and return that
    let sql = 'select id from ( select id, min (($lon - minX + maxX - $lon + $lat - minY + maxY - $lat)/4) as distance ' + 
      ' from rtree where minX <= $lon and maxX >= $lon and minY <= $lat and maxY >= $lat ) ';
    let stmt = ph.store.prepare(sql);
    try {
      let row = stmt.get({ lon: input.lon, lat: input.lat });
      if (row) {
        return hydrateResults([row.id], ph, { filter, input, lang }, (err, docs) => {
          if (err) {
            return res.status(500).send(err);
          }
          return res.status(200).json(docs);
        });
      } else {
        return res.status(200).send([]);
      }
    } catch (err) {
      console.error(err);
      console.error(stmt.source);
    }
   }
  
  // Find the country and its alpha2 code
  let country = '', countryCode = '', postalCode = input.postal_code, stateCode = '';

  // If input is a country code, look up its name
  if (input.country.length === 2 || input.country.length === 3) {
    input.country = input.country.toUpperCase();
    let sql = 'select * from countrycodes ';
    switch (input.country.length) {
      case 2: sql += ' where alpha2 = ? ';
        break;
      case 3: sql += ' where alpha3 = ? ';
        break;
    }
    sql += ' LIMIT 1';
    let stmt = ph.store.prepare(sql);
    try {
      let row = stmt.get(input.country);
      if (row) {
        country = row.name;
        countryCode = row.alpha2;
        input.country = country;
      }
    } catch (err) {
      console.error(err);
      console.error(stmt.source);
    }
  }

  // Use Placeholder search to find the country
  if (countryCode === '' && input.country !== '') {
    ph.query(input.country, (err, result) => {
      let ids = result.getIdsAsArray();
      // create prepared statement
      var stmt = ph.store.prepare('SELECT * FROM countrycodes WHERE id IN ' +
        '(' + Array(ids.length).fill('?').join(',') + ') LIMIT 1');
      try {
        var row = stmt.get(ids);
        if (row) {
          country = row.name;
          countryCode = row.alpha2;
          input.country = country;
        } else {
          // Bad country!!
          input.country = country = countryCode = '';
        }
      } catch (err) {
        console.error(err);
        console.error(stmt.source);
      }
    });
  }
    
  // Cleanup postal code
  postalCode = postalCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); // All unsupported characters removed
  // Ignore obviously bad input!
  if (['OTHER', '00000', '0000', '000', '000000'].includes(postalCode)) {
    postalCode = '';
  }

  // Cleanup (possible) state code
  if (input.state.length > 1 && input.state.length <= 6) {
    stateCode = input.state.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  // Expand postal code to administrative levels
  // Typical case: country and postal code both are available
  // Edge case: Insufficient address - only postal code available, but no country
  if (postalCode.length > 1) {

    // Truncate postal codes for certain countries where our Geonames supplied postal code db has limited coverage
    if (countryCode === 'CA' || countryCode === 'IE' || countryCode === 'MT') {
      postalCode = postalCode.substring(0, 3);
    } else if (countryCode === 'AR') {
      postalCode = postalCode.substring(0, 4);
    } else if (countryCode === 'BR' || countryCode === 'US') {
      postalCode = postalCode.substring(0, 5);
    }

    // Lookup postal code in db
    // We could pick up lat/lon from the postal code db and do reverse geo lookup for lineage
    // But I believe the WOF data is more accurate than Geonames Postalcodes.. 
    // So we just expand postal codes to full locality names and search for that instead
    let postalCodeExpansion = '', searchState = '';
    let stmt = 'SELECT country, placename, admin3name, admin2name, admin1name FROM postalcodes WHERE ';
    
    if (countryCode.length === 2) {
      stmt += ' country = $countryCode AND postalcode_cleaned = $postalCode LIMIT 5';
    } else {
      // If we also have a state code, that can assist removing duplicate postal code matches across multiple countries
      searchState = (stateCode || input.state );
      if (searchState !== '') {
        stmt += ' (admin1code = $searchState OR admin2code = $searchState OR ' +
                ' admin1name like $searchState OR admin2name like $searchState ) AND ';
      }
      stmt += ' (postalcode_cleaned = $postalCode OR postalcode_cleaned = substr($postalCode, 0, 4) OR ' +
        ' postalcode_cleaned = substr($postalCode, 0, 5) OR postalcode_cleaned = substr($postalCode, 0, 6)) ' +
        ' GROUP BY country LIMIT 3';
    }
    stmt = ph.store.prepare(stmt);

    try {
      let rows = stmt.all( {countryCode: countryCode, postalCode: postalCode, searchState: searchState} );
      if (rows && rows.length > 0) {
        if (countryCode.length === 2) {
          let matches = rows.map((row) => _.compact(_.uniq([row.placename, row.admin3name, row.admin2name, row.admin1name])).join(' '));
          postalCodeExpansion = matches.shift(); // Picking up first result
          /*
          postalCodeExpansion = matches.map((v) => {
            return { v: v, d: sift4Distance(text, v) };
          }).sort((a, b) => (a.d < b.d) ? -1 : (a.d > b.d) ? 1 : 0).shift().v;
          */
        } else if (rows.length === 1) {
          // Pick match only if matches are from a single country
          let row = rows[0];
          postalCodeExpansion = _.compact(_.uniq([row.placename, row.admin3name, row.admin2name, row.admin1name])).join(' ');
          input.country = country = countryCode = row.country;
        }
      }
    } catch (err) {
      console.error(err);
      console.error(stmt.source);
    }

    // Replace in input
    input.postal_code = postalCodeExpansion;
  }

  // Expand State code if possible
  if (countryCode.length === 2 && input.state.length > 1 && input.state.length <= 6) {
    let stateCode = input.state.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); // All unsupported characters removed
    let stmt = ph.store.prepare('SELECT subdivision_name FROM iso3166_2 WHERE ' +
      ' replace(code, "-", "") = ?OR replace(code, "-", " ") = ? LIMIT 1');
    try {
      if (stateCode.indexOf(countryCode) !== 0) {
        stateCode = countryCode + stateCode; // We've already replaced - with space in input hence this
      }
      let row = stmt.get(stateCode, stateCode);
      if (row) {
        input.state = row.subdivision_name;
      }
    } catch (err) {
      console.error(err);
      console.error(stmt.source);
    }
  }

  // Remove city and state from input if we've added them to postal code
  ['city', 'state'].forEach(k => {
    if (input.postal_code.match(new RegExp(`${input[k]}\\b`, 'iu'))) {
      input[k] = '';
    }
  });
  
  // Remove short tokens from address or text search strings - they are most likely from street addresses that we don't worry about
  if (input.country || input.postal_code || input.state || input.city) {
    ['text', 'address'].map(k => {
      input[k] = input[k].replace(/(\b(\w{1,2})\b(\W|$))/g, '')
    })
  }

  // Re-Build the search text after all corrections we may have done
  text = [input.text, input.address, input.city, input.state, input.postal_code, input.country].join(' ');
  
  if (debug) { console.error('Searching for: ' + text); }
  
  // Search and return one result
  if (debug) { console.time('took'); }
  ph.query( text, ( err, result ) => {
    if (debug) { console.timeEnd('took'); }
    return hydrateResults(result.getIdsAsArray(), ph, { filter, input, lang }, (err, docs) => {
      if (err) {
        return res.status(500).send(err);
      }
      return res.status(200).json(docs);
    });
  });
};


// Function to take document IDs and return results
function hydrateResults(ids, ph, opts, cb) {
  let { filter, input, lang } = opts;
  if (debug) { console.error('Processing docs: ', ids); }
  // fetch all result docs by id
  ph.store.getMany(ids, function (err, documents) {
    if (err) { return cb( err, []); }
    if (!documents || !documents.length) { return cb( null, []); }

    // placetype filter
    if (Array.isArray(filter.placetype) && filter.placetype.length) {
      documents = documents.filter(d => _.includes(filter.placetype, d.placetype));
    }

    // sort documents according to sorting rules
    documents.sort(sortingAlgorithm);

    // Limit results count
    documents = documents.slice(0, input.limit);
    // get a list of parent ids
    const parentIds = getParentIds(documents);

    // load all the parents
    ph.store.getMany(parentIds, (err, parentResults) => {

      // a database error occurred
      if (err) { return cb(err, []); }

      // handle case where the database was unable to return any rows
      parentResults = parentResults || [];

      // create a map of parents
      const parents = rowsToIdMap(parentResults);

      // map documents to dict using id as key
      let docs = documents.map(function (result) {
        return mapResult(ph, result, parents, lang);
      });

      // If minimal result, strip down result
      if (input.minimal === true) {
        docs = docs.map( minimizeResult );
      }
      // Send json
      return cb( null, docs);
    });
  });
}

/**
 * String distance matching algorithm
 * https://github.com/mailcheck/mailcheck/blob/master/src/mailcheck.js#L138
 */
function sift4Distance(s1, s2, maxOffset) {
  // sift4: https://siderite.blogspot.com/2014/11/super-fast-and-accurate-string-distance.html
  if (maxOffset === undefined) {
      maxOffset = 5; //default
  }

  if (!s1||!s1.length) {
      if (!s2) {
          return 0;
      }
      return s2.length;
  }

  if (!s2||!s2.length) {
      return s1.length;
  }

  var l1=s1.length;
  var l2=s2.length;

  var c1 = 0;  //cursor for string 1
  var c2 = 0;  //cursor for string 2
  var lcss = 0;  //largest common subsequence
  var local_cs = 0; //local common substring
  var trans = 0;  //number of transpositions ('ab' vs 'ba')
  var offset_arr=[];  //offset pair array, for computing the transpositions

  // jshint maxdepth:6
  while ((c1 < l1) && (c2 < l2)) {
      if (s1.charAt(c1) === s2.charAt(c2)) {
          local_cs++;
          var isTrans=false;
          //see if current match is a transposition
          var i=0;
          while (i<offset_arr.length) {
              var ofs=offset_arr[i];
              if (c1<=ofs.c1 || c2 <= ofs.c2) {
                  // when two matches cross, the one considered a transposition is the one with the largest difference in offsets
                  isTrans=Math.abs(c2-c1)>=Math.abs(ofs.c2-ofs.c1);
                  if (isTrans)
                  {
                      trans++;
                  } else
                  {
                      if (!ofs.trans) {
                          ofs.trans=true;
                          trans++;
                      }
                  }
                  break;
              } else {
                  if (c1>ofs.c2 && c2>ofs.c1) {
                      offset_arr.splice(i,1);
                  } else {
                      i++;
                  }
              }
          }
          offset_arr.push({
              c1:c1,
              c2:c2,
              trans:isTrans
          });
      } else {
          lcss+=local_cs;
          local_cs=0;
          if (c1!==c2) {
              c1=c2=Math.min(c1,c2);  //using min allows the computation of transpositions
          }
          //if matching characters are found, remove 1 from both cursors (they get incremented at the end of the loop)
          //so that we can have only one code block handling matches 
          for (var j = 0; j < maxOffset && (c1+j<l1 || c2+j<l2); j++) {
              if ((c1 + j < l1) && (s1.charAt(c1 + j) === s2.charAt(c2))) {
                  c1+= j-1; 
                  c2--;
                  break;
              }
              if ((c2 + j < l2) && (s1.charAt(c1) === s2.charAt(c2 + j))) {
                  c1--;
                  c2+= j-1;
                  break;
              }
          }
      }
      c1++;
      c2++;
      // this covers the case where the last match is on the last token in list, so that it can compute transpositions correctly
      if ((c1 >= l1) || (c2 >= l2)) {
          lcss+=local_cs;
          local_cs=0;
          c1=c2=Math.min(c1,c2);
      }
  }
  lcss+=local_cs;
  return Math.round(Math.max(l1,l2)- lcss +trans); //add the cost of transpositions to the final result
}

function isValidLatLon(lat, lon) {
  return (_.isFinite(lat) && _.isFinite(lon) && _.inRange(lon, -180, 180.1) && _.inRange(lat, -90, 90.1));
}

function minimizeResult(result) {
  if (result.population) { delete result.population; }
  if (result.abbr) { delete result.abbr; }
  if (result.languageDefaulted) { delete result.languageDefaulted; }

  // pick a single lineage, order it and turn it into an array of placenames
  var order = [
    'venue', 'address', 'building', 'campus', 'microhood', 'neighbourhood', 'macrohood', 'borough', 'postalcode',
    'locality', 'metro area', 'localadmin', 'county', 'macrocounty', 'region', 'macroregion',
    'marinearea', 'country', 'empire', 'continent', 'ocean', 'planet'
  ];
  // We need it from top to bottom...
  order.reverse();
  var l = [];
  if( result.lineage.length ){
    var lineage = result.lineage[0];
    order.forEach( function( type ){
      if (lineage.hasOwnProperty(type)) {
        let d = lineage[type];
        if (l.length === 0 || l[l.length - 1] !== d.name) {
          l.push(d.name);
        }
        if (type === 'country') {
          result.countryCode = d.abbr || '';
        }
      }
    });
    result.lineage = l;
  }
  
  result.lat = result.geom.lat;
  result.lon = result.geom.lon;
  delete result.geom;

  return result;
}
