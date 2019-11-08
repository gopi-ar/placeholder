
const _ = require('lodash');
const { arrayParam, sortingAlgorithm, mapResult, rowsToIdMap, getParentIds } = require('./_util');
const PARTIAL_TOKEN_SUFFIX = require('../../lib/analysis').PARTIAL_TOKEN_SUFFIX;

module.exports = function( req, res ){

  // placeholder
  var ph = req.app.locals.ph;

  // input text
  var text = req.query.text || '';

  // placetype filter
  var filter = { placetype: arrayParam( req.query.placetype ) };

  // live mode (autocomplete-style search)
  // we append a byte indicating the last word is potentially incomplete.
  // except where the last token is a space, then we simply trim the space.
  if( req.query.mode === 'live' ){
    if( ' ' === text.slice(-1) ){
      text = text.trim();
    } else {
      text += PARTIAL_TOKEN_SUFFIX;
    }
  }

  // perform query
  console.time('took');
  ph.query( text, ( err, result ) => {
    console.timeEnd('took');

    // language property
    var lang;
    if( 'string' === typeof req.query.lang && req.query.lang.length === 3 ){
      lang = req.query.lang.toLowerCase();
    }

    // fetch all result docs by id
    ph.store.getMany( result.getIdsAsArray(), function( err, documents ){
      if( err ){ return res.status(500).send(err); }
      if( !documents || !documents.length ){ return res.status(200).send([]); }

      // placetype filter
      if( Array.isArray( filter.placetype ) && filter.placetype.length ){
        documents = documents.filter(res => _.includes( filter.placetype, res.placetype ));
      }

      // get a list of parent ids
      const parentIds = getParentIds( documents );

      // load all the parents
      ph.store.getMany( parentIds, ( err, parentResults ) => {

        // a database error occurred
        if( err ){ console.error( 'error fetching parent ids', err ); }

        // handle case where the database was unable to return any rows
        parentResults = parentResults || [];

        // create a map of parents
        const parents = rowsToIdMap( parentResults );

        // map documents to dict using id as key
        const docs = documents.map( function( result ){
          return mapResult( ph, result, parents, lang );
        });

        // sort documents according to sorting rules
        docs.sort( sortingAlgorithm );

        // send json
        res.status(200).json( docs );
      });
    });
  });
};

