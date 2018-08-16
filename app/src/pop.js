#!/usr/bin/env node
'use strict';
var tileReduce = require('@mapbox/tile-reduce');
var path = require('path');

var mbtilesPath = process.argv[2] || "pop.mbtiles",
    binningFactor = +process.argv[3] || 16;

tileReduce({
    map: path.join(__dirname, '/mapPop.js'),
    log: !false,
    sources: [{
        name: 'poptiles',
        mbtiles: mbtilesPath,
        raw: false
    }],
    mapOptions: {
        binningFactor: binningFactor
    }
})
.on('reduce', function(d) {
})
.on('end', function() {
});
