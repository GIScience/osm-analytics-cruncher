'use strict';
var fs = require('fs');

var geojsonVt = require('geojson-vt');
var vtpbf = require('vt-pbf');
var zlib = require('zlib');
var mbtilesPromises = require('./mbtiles-promises');
var queue = require('queue-async');
var turf = require('turf');
var lineclip = require('lineclip');
var sphericalmercator = new (require('sphericalmercator'))({size: 512});
var rbush = require('rbush');
var lodash = require('lodash');
var stats = require('simple-statistics');

const intermediateDir = './intermediate/';

var binningFactor = global.mapOptions.binningFactor; // number of slices in each direction

var aggrTiles;
var initialized = false;

// Filter features touched by list of users defined by users.json
module.exports = function _(tileLayers, tile, writeData, done) {
    if (!initialized) {
        mbtilesPromises.openWrite(intermediateDir + 'pop.aggr.'+process.pid+'.mbtiles')
        .then(function(dbHandle) {
            aggrTiles = dbHandle;
            initialized = true;
            _(tileLayers, tile, writeData, done); // restart process after initialization
        }).catch(function(err) {
            console.error("error while opening db", err);
        });
        return;
    }

    var layer = tileLayers.poptiles.pop;

    if (layer.features.length === 0)
        return done();

    var resultQueue = queue();
    resultQueue.defer(function(done) {
        var tileBbox = sphericalmercator.bbox(tile[0],tile[1],tile[2]);

        var bins = [],
            bboxMinXY = sphericalmercator.px([tileBbox[0], tileBbox[1]], tile[2]),
            bboxMaxXY = sphericalmercator.px([tileBbox[2], tileBbox[3]], tile[2]),
            bboxWidth  = bboxMaxXY[0]-bboxMinXY[0],
            bboxHeight = bboxMaxXY[1]-bboxMinXY[1];
        for (var i=0; i<binningFactor; i++) {
            for (var j=0; j<binningFactor; j++) {
                var binMinXY = [
                    bboxMinXY[0] + bboxWidth /binningFactor*j,
                    bboxMinXY[1] + bboxHeight/binningFactor*i
                ], binMaxXY = [
                    bboxMinXY[0] + bboxWidth /binningFactor*(j+1),
                    bboxMinXY[1] + bboxHeight/binningFactor*(i+1)
                ];
                var binMinLL = sphericalmercator.ll(binMinXY, tile[2]),
                    binMaxLL = sphericalmercator.ll(binMaxXY, tile[2]);
                bins.push([
                    binMinLL[0],
                    binMinLL[1],
                    binMaxLL[0],
                    binMaxLL[1],
                    i*binningFactor + j
                ]);
            }
        }
        var binPopulation = Array(bins.length+1).join(0).split('').map(Number); // initialize with zeros
        var binTree = rbush();
        binTree.load(bins);

        layer.features.forEach(function(feature) {
            var clipper = lineclip.polygon,
                geometry = feature.geometry.coordinates[0];

            var featureBbox = turf.extent(feature);
            var featureBins = binTree.search(featureBbox).filter(function(bin) {
                var clipped = clipper(geometry, bin);
                return clipped === true || clipped.length > 0;
            });
            featureBins.forEach(function(bin) {
                var index = bin[4];
                binPopulation[index] += feature.properties.pop/featureBins.length;
                //todo: ^- better association (by area ratio if featureBins.length > 1)
            });
        });

        var output = turf.featurecollection(bins.map(turf.bboxPolygon));
        output.features.forEach(function(feature, index) {
            feature.properties.binX = index % binningFactor;
            feature.properties.binY = Math.floor(index / binningFactor);
            feature.properties.pop = binPopulation[index];
        });
        output.features = output.features.filter(function(feature) {
            return feature.properties.pop >= 1;
        });
        //output.properties = { tileX: tile[0], tileY: tile[1], tileZ: tile[2] };

        var tileData = geojsonVt(output, {
            maxZoom: 12,
            buffer: 0,
            tolerance: 1, // todo: faster if >0? (default is 3)
            indexMaxZoom: 12
        }).getTile(tile[2], tile[0], tile[1]);
        if (tileData === null || tileData.features.length === 0) {
            done();
        } else {
            var pbfout = zlib.gzipSync(vtpbf.fromGeojsonVt({ 'pop': tileData }));
            aggrTiles.putTile(tile[2], tile[0], tile[1], pbfout, done);
        }
    });
    resultQueue.await(function(err) {
        if (err) console.error(err);
        done();
    });

};


process.on('SIGHUP', function() {
    mbtilesPromises.closeWrite(aggrTiles)
    .then(function() {
        process.exit(0);
    }).catch(function(err) {
        console.error("error while closing db", err);
        process.exit(13);
    });
});
