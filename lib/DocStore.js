
var util = require('util');
var Database = require('./Database');

// document store database
function DocStore(){}
util.inherits( DocStore, Database );

DocStore.prototype.reset = function(){
  this.db.exec('DROP TABLE IF EXISTS docs');
  this.db.exec('CREATE TABLE docs( id INTEGER PRIMARY KEY, json TEXT, population numeric default 0, area numeric default 0 )');

  // create rtree table
  this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS rtree USING rtree( id, minX, maxX, minY, maxY, minZ, maxZ )');

  // triggers to keep the rtree index up-to-date
  var triggers = {
    insert: `INSERT INTO rtree ( id, minX, maxX, minY, maxY, minZ, maxZ ) VALUES (
      new.id,
      json_extract( json( '[' || json_extract( new.json, '$.geom.bbox' ) || ']' ), '$[0]' ),
      json_extract( json( '[' || json_extract( new.json, '$.geom.bbox' ) || ']' ), '$[2]' ),
      json_extract( json( '[' || json_extract( new.json, '$.geom.bbox' ) || ']' ), '$[1]' ),
      json_extract( json( '[' || json_extract( new.json, '$.geom.bbox' ) || ']' ), '$[3]' ),
      json_extract( new.json, '$.rank.min' ),
      json_extract( new.json, '$.rank.max' )
    )`,
    delete: 'DELETE FROM rtree WHERE id = old.id'
  };

  this.db.exec(`CREATE TRIGGER IF NOT EXISTS rtree_insert_trigger
    AFTER INSERT ON docs
    BEGIN ${triggers.insert}; END`);

  this.db.exec(`CREATE TRIGGER IF NOT EXISTS rtree_delete_trigger
    AFTER DELETE ON docs
    BEGIN ${triggers.delete}; END`);

  this.db.exec(`CREATE TRIGGER IF NOT EXISTS rtree_update_trigger
    AFTER UPDATE ON docs
    BEGIN ${triggers.delete}; ${triggers.insert}; END`);
};

// ensure that the database schema matches what is expected by the codebase
DocStore.prototype.checkSchema = function(){
  Database.assertSchema(this.db, 'docs', [
    { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: 'json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 2, name: 'population', type: 'numeric', notnull: 0, dflt_value: '0', pk: 0 },
    { cid: 3, name: 'area', type: 'numeric', notnull: 0, dflt_value: '0', pk: 0 }
  ]);
  Database.assertSchema(this.db, 'rtree', [
    { cid: 0, name: 'id', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 1, name: 'minX', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 2, name: 'maxX', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 3, name: 'minY', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 4, name: 'maxY', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 5, name: 'minZ', type: '', notnull: 0, dflt_value: null, pk: 0 },
    { cid: 6, name: 'maxZ', type: '', notnull: 0, dflt_value: null, pk: 0 }
  ]);
};

DocStore.prototype.set = function( id, doc, cb ){

  // create prepared statement
  var stmt = this.prepare('INSERT INTO docs (id, json) VALUES ($id, $json)');

  try {
    stmt.run({ id: id, json: DocStore.codec.encode( doc ) });
    return cb( null );
  } catch ( err ){
    console.error( err );
    console.error( stmt.source );
    return cb( err );
  }
};

DocStore.prototype.get = function( id, cb ){

  // create prepared statement
  var stmt = this.prepare('SELECT json FROM docs WHERE id = ? LIMIT 1');

  try {
    var doc = stmt.get( id );
    if( !doc ){ return cb( 'not found' ); }
    return cb( null, DocStore.codec.decode( doc ) );
  } catch ( err ){
    console.error( err );
    console.error( stmt.source );
    return cb( err );
  }
};

DocStore.prototype.getMany = function( ids, cb ){

  if( !Array.isArray( ids ) || !ids.length ){
    return cb( null, [] );
  }

  // create prepared statement
  var stmt = this.prepare('SELECT json FROM docs WHERE id IN ' +
    '(' + Array(ids.length).fill('?').join(',') + ')'
  );

  // var stmt = this.prepare('SELECT json FROM docs WHERE id IN ( ? )');

  try {
    var docs = stmt.all( ids );
    if( !docs ){ return cb( 'not found' ); }
    return cb( null, docs.map( DocStore.codec.decode ));
  } catch ( err ){
    console.error( err );
    console.error( stmt.source );
    console.error( ids );
    return cb( err );
  }
};

DocStore.prototype.getFew = function( ids, options, cb ){

  if( !Array.isArray( ids ) || !ids.length ){
    return cb( null, [] );
  }

  let conditions = ' ';
  let params;
  let needToMergeParams = false;
  if (options) {
    if (Array.isArray(options.placetype) && options.placetype.length > 0) {
      conditions += ' AND json_extract(json, "$.placetype") IN ' +
        '(' + Array(options.placetype.length).fill('?').join(',') + ') ';
      needToMergeParams = true;
    }

    // Add order by 
    conditions += ' ORDER BY population DESC, area DESC ';
    if (options.limit && !Number.isNaN(options.limit)) {
      conditions += ' LIMIT ' + options.limit;
    }
  }

  // create prepared statement
  var stmt = this.prepare('SELECT json FROM docs WHERE id IN ' +
    '(' + Array(ids.length).fill('?').join(',') + ')' + conditions
  );

  if (needToMergeParams === true) {
    params = [...ids, ...options.placetype];
  } else {
    params = ids;
  }

  try {
    var docs = stmt.all( params );
    if( !docs ){ return cb( 'not found' ); }
    return cb( null, docs.map( DocStore.codec.decode ));
  } catch ( err ){
    console.error( err );
    console.error( stmt.source );
    console.error( params );
    return cb( err );
  }
};

// encode/decode json strings
DocStore.codec = {
  encode: ( decoded ) => {
    return JSON.stringify( decoded );
  },
  decode: ( encoded ) => {
    return JSON.parse( encoded.json );
  }
};

module.exports = DocStore;
