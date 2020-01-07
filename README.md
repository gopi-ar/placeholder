>This is a fork of [Pelias Placeholder](https://github.com/pelias/placeholder)
>Pelias Placeholder is an open-source, last-line parser for unstructured geo text.

# Geocoding for structured and unstructured addresses

If you need "last-line" address parsing (up to neighbourhood / locality level, and not street level), this is the solution!

## Pelias Placeholder: natural language parser for geographic text

This work is based on Pelias Placeholder. 

Placeholder takes unstructured input text, such as 'Neutral Bay North Sydney New South Wales' and attempts to deduce the geographic area the user is referring to.

Human beings (familiar with Australian geography) are able to quickly scan the text and establish that there 3 distinct token groups: 'Neutral Bay', 'North Sydney' & 'New South Wales'.

The engine uses a similar technique to our brains, scanning across the text, cycling through a dictionary of learned terms and then trying to establish logical token groups.

Once token groups have been established, a reductive algorithm is used to ensure that the token groups are logical in a geographic context. We don't want to return New York City for a term such as 'nyc france', so we need to only return things called 'nyc' *inside* places called 'france'.

The engine starts from the rightmost group, and works to the left, ensuring token groups represent geographic entities contained *within* those which came before. This process is repeated until it either runs out of groups, or would return 0 results.

The best estimation is then returned, either as a set of integers representing the ids of those regions, or as a JSON structure which also contains additional information such as population counts etc.

The data is sourced from the [whosonfirst](https://github.com/whosonfirst-data/whosonfirst-data) project, this project also includes different language translations of place names.

Placeholder supports searching on and retrieving tokens in different languages and also offers support for synonyms and abbreviations.

The engine includes a rudimentary language detection algorithm which attempts to detect right-to-left languages and languages which write their addresses in major-to-minor format. It will then reverse the tokens to re-order them in to minor-to-major ordering.

---

## What we've changed in Placeholder?

Quite a few things:

### At least 30% faster

Placeholder runs dozens (or hundreds) of database queries for full text searches. But this code runs only one.

This significantly improves performance for longer addresses / complex searches.

**These optimization [changes are also in this pull request](https://github.com/pelias/placeholder/pull/163).**

### A new `/xsearch` endpoint

All the new features are exposed only through a new `/parser/xsearch` endpoint. Existing Placeholder routes won't have these new features - and continue working as-is.

### Support for structured address input (in addition to unstructured)

* You can pass `country`, `state`, `postal_code`, `city` and `address` as separate inputs.
* Engine automatically turns country and state ISO codes into full names before searching.

### Postal Code expansion

* Postal codes are expanded to proper admin names using [Geonames Postal Code](https://download.geonames.org/export/zip) data.
* This improves accuracy and coverage significantly.
* Works only for structured input. Can't reliably detect postal codes in unstructured input.
* If no country code is given, search the system and expand if only one matching postal code found.
* When there are multiple matches for a given postal code in given country, we just pick the first one.

### Reverse Geocoding - get place names from longitude / latitude

* Passing `lat` and `lon` will do reverse lookup and provide geocoded names for the enclosing place.

### Minimal output mode, Limiting number of results

* Adding `minimal=1` parameter will simplify and shorten the output. For example:

```javascript
[
    {
        "id": 85688543,
        "name": "New York",
        "placetype": "region",
        "lineage": [
            "North America",
            "United States",
            "New York"
        ],
        "countryCode": "USA",
        "lat": 43.408777,
        "lon": -74.871618
    }
]
```

* Adding `limit=5` will only return the first five matches. Set limit to 1 if you are doing automatic geocoding in batches or for non-interactive use.

### Country code in output. 

Since minimal output mode turns lineage into a simple ordered array of strings, we've added 3-letter abbreviation of the country to the output. This helps many geocoding needs.

---

## Requirements

There are quite a few steps to getting this to work! Code is in Node.js, DB is SQLite.

But the core work is setting up the data.

* First, make sure [Placeholder](https://github.com/pelias/pelias) is setup.
* Follow Placeholder instructions to download / setup the `store.sqlite`
* We need to add `countrycodes`, `iso3166`, `iso3166_2` and `postalcodes` tables to the same db.


### postalcodes table
* `postalcodes` is the Geonames Postal Code data. Downloaded as a CSV and then imported. 
* Import command:
```bash
$  sqlite3 store.sqlite3 
.mode csv
.separator "\t"
.import "~/Downloads/geonames/postcodes-geonames-allCountries.txt" postalcodes
```

* Table structure will be:
```sql
CREATE TABLE "postalcodes" (
	"country"	TEXT NOT NULL,
	"postalcode"	TEXT,
	"placename"	TEXT,
	"admin1name"	TEXT,
	"admin1code"	TEXT,
	"admin2name"	TEXT,
	"admin2code"	TEXT,
	"admin3name"	TEXT,
	"admin3code"	TEXT,
	"latitude"	NUMERIC,
	"longitude"	NUMERIC,
	"accuracy"	INTEGER)
```

* We also added the entire postal code data for Great Britain and Netherlands from Geonames.

```sql
delete from postalcodes where country = 'GB' or country = 'NL';

.mode csv
.separator "\t"
.import "~/Downloads/geonames/GB_full.txt" postalcodes

.mode csv
.separator "\t"
.import "~/Downloads/geonames/NL_full.txt" postalcodes
update postalcodes set accuracy = 6 where country = 'NL';
```

* Imported postal codes for Brazil. 
    * Downloaded from [CEP](http://cep.la/baixar)
    * `grep "000\t" ceps.txt | cut -f1 -f2 -s > major-two.txt`
    * Edit file in text-editor. 
    * Add headers - country, postalcode, placename, admin1name, admin2name
    * Replace ( with tab
    * Replace ) with nothing
    * Replace / with tab
    * Save as .csv
    * Then import this into SQLite as a new table - `brazil_postcodes`
    * Then run:
        ```sql    
        delete from postalcodes where country = 'BR';
        insert into postalcodes (country, postalcode, placename, admin1name, admin2name, postalcode_cleaned)
        select 'BR' as country, postal, placename, admin1, admin2, postal from brazil_postcodes;
        drop table brazil_postcodes;
        update postalcodes set postalcode = substr(postalcode, 0, 6) where country = 'BR';
        ```

* Some additional steps...

```sql
alter table postalcodes ADD postalcode_cleaned text;

update postalcodes set postalcode_cleaned = upper( replace( replace(postalcode, '-', ''), ' ', ''));

CREATE INDEX "postalcode_idx" ON "postalcodes" (
	"country"	ASC,
	"postalcode_cleaned"	ASC,
	"admin1name"	ASC,
	"admin1code"	ASC,
	"admin2name"	ASC,
	"admin2code"	ASC
);```

### iso3166 and iso3166_2 tables

* iso3166 [data from @lukes on GitHub](https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv)
* Remove extra fields and change field names - headings. Then import to DB such that structure is like following:
```sql
CREATE TABLE "iso3166" (
	"name"	TEXT,
	"alpha2"	TEXT,
	"alpha3"	TEXT,
	"code"	INTEGER
)
```

* iso3166_2 [data from ip2location](https://www.ip2location.com/free/iso3166-2). Download their CSV and import as a new table.
```sql
.mode csv
.separator ","
.import "~/Downloads/ip2location-iso3166-2/IP2LOCATION-ISO3166-2.CSV" iso3166_2;
CREATE INDEX "iso3166_2_idx" ON "iso3166_2" ( "code"	ASC );
```

### countrycodes table

Extracting country codes from existing WOF data... (requires iso3166 table to be present)

```sql
create table countrycodes as
    select  d.id as id, json_extract(d.json, "$.name") as name, json_extract(d.json, "$.abbr") as alpha3, i.alpha2 as alpha2
  from docs d, iso3166 i
  where
  json_extract(json, "$.abbr") = i.alpha3
  and json_extract(json, "$.placetype") in ("country", "empire", "dependency", "disputed");

CREATE UNIQUE INDEX "countrycodes_idx" ON "countrycodes" (
    "id"    ASC,
    "alpha3"    ASC,
    "alpha2"    ASC
);
```

---

### Additional DB optimizations

- Enable WAL mode for concurrency and faster performance

- Index on token, lang and id because that's the data we used most often
- Move out population and area fields to table level so we can quickly sort on them without json_extract

```sql
CREATE INDEX tokens_id_lang_token_idx ON tokens(id, lang, token);

alter table docs 
add column population numeric default 0;

alter table docs 
add column area numeric default 0; 

update docs set 
	population = CASE 
		WHEN json_extract(json, "$.population") > 0 THEN json_extract(json, "$.population") 
		WHEN json_extract(json, "$.popularity") > 0 THEN json_extract(json, "$.popularity") 
		ELSE 0 END, 
	area = CASE 
		WHEN json_extract(json, "$.geom.area") > 0 THEN json_extract(json, "$.geom.area") 
		ELSE 0 END;
	
CREATE INDEX "docs_sorting_idx" ON "docs" (
	"id"	ASC,
	"population"	DESC,
	"area"	DESC
);
```