

var _ = require('underscore');
var async = require('async');
var influx  = require('influx');

var MongoClient = require('mongodb').MongoClient
    , Server = require('mongodb').Server;

var configuration =
{
    influxserver : {
        user        : 'root',
        password    : 'root',
        hostname    : 'localhost',
        port        : 8086
    },
    influxdb : {
        user        : 'dbuser',
        password    : '',
        hostname    : 'localhost',
        port        : 8086,
        database    : 'default'

    },
    mongodb : {
        user        : '',
        password    : '',
        hostname    : 'localhost',
        port        : 27017,
        database    : 'default',
        querylimit  : 100000
    },
    logging         : true,
    limit           : 2,
    insertlimit     : 100,
    emptySeries     : false

};

var influxServer, influxDB, mongoClient, mongodb;


var Mongo2Influx = function(options)
{

    if (options.influxdb)
        _.extend(configuration.influxdb,options.influxdb);

    if (options.influxserver)
        _.extend(configuration.influxserver,options.influxserver);


    if (options.mongodb)
        _.extend(configuration.mongodb,options.mongodb);

    if (options.limit) configuration.limit = options.limit;
    if (options.logging) configuration.logging = options.logging;
    if (options.emptySeries) configuration.emptySeries = options.emptySeries;

};

Mongo2Influx.prototype.connect = function (cb)
{

    influxServer = influx(
        configuration.influxserver.hostname,
        configuration.influxserver.port,
        configuration.influxserver.user,
        configuration.influxserver.password,
        configuration.influxserver.database
    );

    influxDB = influx(
        configuration.influxdb.hostname,
        configuration.influxdb.port,
        configuration.influxdb.user,
        configuration.influxdb.password,
        configuration.influxdb.database
    );
    mongoClient = new MongoClient(new Server(configuration.mongodb.hostname, configuration.mongodb.port));

    mongoClient.open(function ( err, mongoClient ) {
        if (err) {
            return cb(err);
        }
        mongodb = mongoClient.db(configuration.mongodb.database);
        return cb(null);

    });
};


Mongo2Influx.prototype.log = function ()
{
    if (configuration.logging) {
        console.log(_.values(arguments).join(' '));
    }
};



Mongo2Influx.prototype.migrateCollection = function(prepareFunction, collection,callbackCollections)
{
    var self = this;
    var collectionName = collection.collectionName;
    var startDump = new Date();

    self.countItems(collection,function(err,itemCount)
    {
        if (err) return callbackCollections(err);
        var jobCount = Math.ceil(itemCount/configuration.mongodb.querylimit);
        var mongoJobs = [];
        for (var i=0; i<jobCount;++i)
            mongoJobs.push(i*configuration.mongodb.querylimit);

        var rowsSkipped = 0;
        async.eachSeries(mongoJobs,function(mongoOffset,callbackFind)
        {
            collection.find().limit(configuration.mongodb.querylimit).skip(mongoOffset).toArray(function(err, results) {
                if (!err && _.isArray(results))
                {
                    self.log('reading results from',collectionName,results.length,'rows, took',(new Date()-startDump),'ms');

                    var index =0;
                    var lastIndex =0;

                    var startMigration = new Date();

                    var jobCount = Math.ceil(results.length/configuration.insertlimit);
                    var jobs = [];
                    for (var i=0; i<jobCount;++i)
                        jobs.push(i*configuration.insertlimit);

                    var bench = function()
                    {
                        var inserts = index-lastIndex;
                        lastIndex=index;
                        var diff = (new Date()-startMigration) / 1000;
                        var ips = Math.round(inserts/ diff);
                        self.log('collection',collectionName,'item #',index,'@',ips,'inserts/sec');
                        startMigration = new Date();

                    };

                    var statInterval = setInterval(bench,2500);


                    async.eachLimit(jobs,configuration.limit,function(offset,cb){
                        var data = [];
                        var offsetLimit = offset + configuration.insertlimit -1;
                        if (offsetLimit >= results.length) offsetLimit = results.length-1;

                        for (var i=offset;i<=offsetLimit;++i)
                        {
                            var row = prepareFunction(results[i]);
                            if (!row.time) {
                                rowsSkipped++;
                            } else {
                                data.push(row);
                            }
                        }

                        influxDB.writePoints(collectionName, data , {pool : false}, function(err) {
                            if (err)
                            {
                                return cb(err)
                            }
                            else {
                                index += data.length;
                                return cb();
                            }
                        });
                    },function(err)
                    {
                        clearInterval(statInterval);
                        callbackFind(err);
                    });
                } else {
                    results = null;
                    callbackFind(err);
                }
            });
        },function(err)
        {
            if (err)
            {
                self.log('error migrating collection',collectionName);

            } else {
                var successRate = 100 / itemCount * (itemCount-rowsSkipped);
                self.log('collection',collectionName,'done, skipped',rowsSkipped,'rows, successrate:',successRate,'%');
            }
            callbackCollections(err);
        });
    });
};


Mongo2Influx.prototype.countItems = function (collection,callback)
{
    collection.count(function(err,count)
    {
        callback(err,count);
    });
};


Mongo2Influx.prototype.migrateCollections = function( prepareFunction, options, collections, callback )
{
    var self = this;
    self.log('found',collections.length,'collection');
    async.eachSeries(collections,function( collection, callbackCollections )
    {
        var collectionName = collection.collectionName;
        if ( -1 !== collectionName.indexOf('system')) return callbackCollections();
        self.log('next collection: ',collectionName);

        if (true === configuration.emptySeries)
        {
            self.emptySeries(collection.collectionName,function()
            {
                self.migrateCollection(prepareFunction, collection,callbackCollections);
            })
        } else {
            self.migrateCollection(prepareFunction, collection,callbackCollections);
        }
    },callback);
};



Mongo2Influx.prototype.emptySeries = function(collectionName,callback)
{
    var self = this;
    var start = new Date();
    self.log('Truncating influx series',collectionName);
    influxDB.readPoints('DELETE FROM '+collectionName+' WHERE time < now();',function(err)
    {
        var diff = new Date()-start;

        self.log('took',diff,'ms');
        callback(err);
    });
};



Mongo2Influx.prototype.migrate = function ( prepareFunction, options, callback )
{
    if (!mongodb)
    {
        return callback('mongodb is not connected');
    }

    if ('function' == typeof options)
        callback = options;

    if ('function' != typeof prepareFunction)
        return callback('missing prepare function');
    var self = this;
    mongodb.collections(function(err,collections)
    {
        if (err)
        {
            callback(err);
        } else {
            self.migrateCollections(prepareFunction,options, collections,callback);
        }
    });
};


module.exports = Mongo2Influx;