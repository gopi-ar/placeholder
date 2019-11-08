
// in express, if you pass query params like this `?param[]=value`
// then the type of the param is Array and the code may be expecting a string.
// this convenience function allows either form to be used.
function arrayParam( param ){
  var res = [];

  // accept param as array. eg: param[]=value
  if( Array.isArray( param ) ){ res = param; }

  // accept param as string. eg: param=value
  if( 'string' === typeof param ){ res = param.split(','); }

  // trim strings and remove empty elements
  return res.map(a => a.trim()).filter(a => a.length);
}

/**
  sort highest 'population' first, using 'geom.area' as a second
  sorting condition where population data is not available.
**/
function sortingAlgorithm( a, b ){

  // condition 1 - population or popularity
  const a1 = a.population || a.popularity || 0;
  const b1 = b.population || b.popularity || 0;

  // condition 2 - geom.area
  const a2 = a.geom && a.geom.area || 0;
  const b2 = b.geom && b.geom.area || 0;

  if( a1 < b1 ){ return +1; }
  if( a1 > b1 ){ return -1; }
  if( a2 < b2 ){ return +1; }
  if( a2 > b2 ){ return -1; }
  return 0;
}

function mapResult( ph, result, parents, lang ){

  // swap languages
  if( Array.isArray( result.names[lang] ) && result.names[lang].length ){
    result.name = result.names[lang][0];
    result.languageDefaulted = false;
  } else {
    result.languageDefaulted = true;
  }

  // delete language properties
  delete result.names;

  // delete rank properties
  delete result.rank;

  result.lineage = result.lineage.map( function( lineage ){
    return mapLineage( ph, lineage, parents, lang );
  });
  return result;
}

function mapLineage( ph, lineage, parents, lang ){
  const res = {};

  for( var attr in lineage ){
    var parent = parents[ lineage[ attr ] ];

    if( !parent ){
      console.error( 'parent not found!', attr, lineage[ attr ] );
      continue;
    }

    var name = parent.name;
    var languageDefaulted = true;

    // swap languages
    if( Array.isArray( parent.names[lang] ) && parent.names[lang].length ){
      languageDefaulted = false;
      name = parent.names[lang][0];
    }

    res[ parent.placetype ] = {
      id: parent.id,
      name: name,
      abbr: parent.abbr,
      languageDefaulted: languageDefaulted
    };
  }

  return res;
}

// convert array of results to map using id as key
function rowsToIdMap( rows ){
  const map = {};
  rows.forEach( function( row ){
    map[ row.id ] = row;
  });
  return map;
}

// get a unique array of parent ids
function getParentIds( results ){
  const parentIds = {};
  results.forEach( function( row ){
    row.lineage.forEach( function( lineage ){
      for( var attr in lineage ){
        parentIds[ lineage[attr] ] = true;
      }
    });
  });
  return Object.keys( parentIds );
}

module.exports = {
  arrayParam: arrayParam,
  sortingAlgorithm: sortingAlgorithm,
  mapResult: mapResult,
  rowsToIdMap: rowsToIdMap,
  getParentIds: getParentIds
};
