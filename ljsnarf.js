var 
	// argv        = require('optimist').argv,
	crypto      = require('crypto'),
	fs          = require('fs'),
	http        = require('http'),
	path        = require('path'),
	requester   = require('chainable-request').chainableRequest,
	url         = require('url'),
	util        = require('util'),
	winston     = require('winston');

require('js-yaml');

var VERSION = '0.1.3';
var USERAGENT = { 'User-Agent': 'ljsnarf LJ backup ' + VERSION + '(https://github.com/ceejbot/ljsnarf; <ceejceej@gmail.com>; en-US)'};

// lj's time format: 2004-08-11 13:38:00
var ljTimeFormat = '%Y-%m-%d %H:%M:%S';
var apipath = '/interface/xmlrpc'; // unused
var flatpath = '/interface/flat';

//------------------------------------------------------------------------------
// array update/extend.
function __extend(destination, source)
{
	for (var property in source)
	{
		if (source.hasOwnProperty(property))
			destination[property] = source[property];
	}
	return destination;
}

//------------------------------------------------------------------------------

var Account = function(options)
{
	this.host = options.server.replace('http://', '');
	this.port = options.port;
	this.user = options.user;
	this.password = options.password;
	
	this.session = '';
	this.journal = this.user;
	this.site = this.host; // TODO clean up
	this.groupmap = null;
}

Account.prototype.journalPath = function()
{
	return path.join('.', 'backup', this.site, this.journal);
};
Account.prototype.metapath = function()
{
	return path.join(this.journalPath(), 'metadata');
};
Account.prototype.postspath = function()
{
	return path.join(this.journalPath(), 'posts');
};
Account.prototype.userpicspath = function()
{
	return path.join(this.journalPath(), 'userpics');
};

Account.prototype.requester = function()
{
	return new requester({hostname: this.host, port: this.port}).
			headers(USERAGENT);
}

//------------------------------------------------------------------------------
// Flat API, challenge/response, and other LJ communication plumbing

Account.prototype.handleFlatResponse = function(input)
{
	// Read lines from input stream in name/value pairs.
	// Return hash containing the results.
	var result = {};
	var lines = input.split('\n');
	var i = 0;
	while (i < lines.length - 1)
	{
		result[lines[i]] = lines[i+1];
		i += 2;
	}
	return result;
};

Account.prototype.respondToChallenge = function(chal)
{
	var passhash = crypto.createHash('md5').update(this.password).digest('hex');
	var pseudohmac = crypto.createHash('md5').update(chal + passhash).digest('hex');
	return pseudohmac;
};

Account.prototype.doChallengeFlat = function(callback)
{
	logger.debug('requesting fresh challenge');
	var self = this;
	self.requester().
		content_type('application/x-www-form-urlencoded').
		body({'mode': 'getchallenge'}).
		post('/interface/flat').
		on('reply', function(response, body)
	{
		data = self.handleFlatResponse(body);
		if (data.errmsg !== undefined)
			return callback(data.errmsg);
		
		var result = {
			'auth_method': 'challenge',
			'auth_challenge': data['challenge'],
			'auth_response': self.respondToChallenge(data['challenge']),
			'expires': new Date(data['expire_time'] * 1000),
			'user': self.user,
			'username': self.user,
		};
		callback(result);
	});
};

// Params must be a hash.
Account.prototype.makeFlatAPICall = function(method, params, callback)
{
	logger.debug("making flat API call with mode: ", method);
	var self = this;
	this.doChallengeFlat(function(challenge)
	{
		__extend(params, challenge);
		params['mode'] = method;

		self.requester().
			content_type('application/x-www-form-urlencoded').
			body(params).
			post('/interface/flat').
			on('reply', function(response, body)
		{
			data = self.handleFlatResponse(body);
			callback(data);
		});
	});
};

//------------------------------------------------------------------------------

Account.prototype.makeSession = function(callback)
{
	var self = this;
	logger.info('Generating session using challenge/response');
	
	self.requester().
		content_type('application/x-www-form-urlencoded').
		body({'mode': 'getchallenge'}).
		post('/interface/flat').
		on('reply', function(response, body)
	{
		data = self.handleFlatResponse(body);
		if (data.errmsg !== undefined)
			return callback(data.errmsg);
		
		challenge = data['challenge'];
		challengeResponse = self.respondToChallenge(challenge);
		
		var sessiondata = {
			mode : 'sessiongenerate',
			user : self.user,
			auth_method: 'challenge',
			auth_challenge: challenge,
			auth_response: challengeResponse
		};
		self.requester().
			content_type('application/x-www-form-urlencoded').
			body(sessiondata).
			post('/interface/flat').
			on('reply', function(response, body)
		{
			data = self.handleFlatResponse(body);
			self.ljsession = data['ljsession'];
			callback(null);
		});
	})	
};

//------------------------------------------------------------------------------

Account.prototype.metadataFileForRead = function(fname, callback)
{
	var pname = path.join(self.metapath(), fname);
	return fs.openSync(pname, 'r');
};

Account.prototype.metadataFileForWrite = function(fname, callback)
{
	var pname = path.join(self.metapath(), fname);
	return fs.openSync(pname, 'w');
};

//------------------------------------------------------------------------------

Account.prototype.getSyncItems = function(lastsync, callback)
{
	var self = this;
	if ((lastsync !== undefined) && (lastsync.length > 0))
		syncdate = lastsync;
	else
		syncdate = '';
		
	var params = {
		mode : 'syncitems',
		ver: 1,
		lastsync: syncdate,
		user : self.user,
	};

	self.makeFlatAPICall('syncitems', params, function(data)
	{
		// Massage the data into a more useful structure.
		var results = {};
		results['sync_count'] = data['sync_count']; // how many in this pass
		results['sync_total'] = data['sync_total']; // how many total
		results['sync_items'] = [];
		
		for (var i=1; i <= results.sync_count; i++)
		{
			results.sync_items.push({
				id: data['sync_'+i+'_item'],
				action: data['sync_'+i+'_action'],
				time: data['sync_'+i+'_time'],
			});
		}
		
		callback(results);
	});
};

//------------------------------------------------------------------------------
// sync items one at a time

Account.prototype.getOneEvent = function(itemid, callback)
{
	var self = this;
	itemid = itemid.replace(/^L-/, '');
	itemid = itemid.replace(/^C-/, '');
		
	var params = {
		username: self.user,
		user: self.user,
		ver: 1,
		selecttype: "one",
		itemid: itemid,
	};
	self.makeFlatAPICall('getevents', params, function(data)
	{
		var entry = {};
		entry.itemid = data['events_1_itemid'];
		entry.anum = data['events_1_anum'];
		entry.url = data['events_1_url'];
		entry.time = data['events_1_eventtime'];
		entry.subject = data['events_1_subject'];
		entry.body = unescape(data['events_1_event']);
		
		entry.properties = {};
		var propcount = data.prop_count;
		for (var i=1; i <= propcount; i++)
			entry.properties[data['prop_'+i+'_name']] = data['prop_'+i+'_value'];

		callback(entry);
	});
};

Account.prototype.fetchItem = function(item, callback)
{
	var self = this;

	self.getOneEvent(item.id, function(entry)
	{
		var location = url.parse(entry.url);
		var pieces = location.pathname.split('/');
		var basename = pieces[pieces.length - 1].replace('.html', '.json');
		var fname = path.join(self.postspath(), basename);
		fs.writeFile(fname, JSON.stringify(entry, null, true), 'utf8', function(err)
		{
			logger.info('backed up entry '+basename);
			callback(err, entry);
		});		
	});
};

Account.prototype.fetchSyncItemsSingly = function(lastsync, count, callback)
{
	var self = this;
	logger.info("fetching sync items one at a time, starting with " + JSON.stringify(lastsync));
	self.getSyncItems(lastsync, function(itemsSinceLastSync)
	{
		if ((itemsSinceLastSync === null) || (itemsSinceLastSync.sync_items.length == 0))
		{
			logger.info('nothing to update');
			return callback(lastsync, count, 0);
		}
			
		var newentries = 0;
		var totalToFetch = itemsSinceLastSync.sync_total;
		var syncitems = itemsSinceLastSync.sync_items;
		
		// TODO: fetch them in groups to minimize network overhead.
		var pending = 0;
		for (var i=0; i < syncitems.length; i++)
		{
			var item = syncitems[i];
			// if item id starts with L, fetch entry
			if (item.id[0] != 'L')
				continue;
			pending++;
			self.fetchItem(item, function(err, entry)
			{
				count++;
				if (lastsync < item.time) lastsync = item.time;
				--pending || callback(lastsync, count, totalToFetch - syncitems.length);
			});
		}
	});
};

Account.prototype.backupJournalEntriesSingly = function(callback)
{
	var self = this;
	logger.info('Fetching new and updated journal entries.');
	
	self.readLastSync(function(lastsync)
	{
		var previousSyncDate = lastsync;

		var recordResults = function(syncdata, newentries)
		{
			self.writeLastSync(syncdata, function()
			{
				logger.info("Local json archive complete.")
				if (previousSyncDate.length > 0)
					logger.info(newentries+' entries recorded since '+previousSyncDate);
				else
					logger.info(newentries+' entries recorded');
				callback();
			});
		};
		
		var continuer = function(syncdata, count, remaining)
		{
			if (remaining <= 0)
				recordResults(syncdata, count);
			else
				self.fetchSyncItemsSingly(syncdata, count, continuer);
		};		
		self.fetchSyncItemsSingly(lastsync, 0, continuer);
	});
};



//------------------------------------------------------------------------------
// sync items in batches

Account.prototype.getEventsSince = function(sinceDate, callback)
{
	var self = this;
	var params = {
		username: self.user,
		user: self.user,
		ver: 1,
		selecttype: 'syncitems',
		lastsync: sinceDate,
		lineendings: 'unix'
	};
	
	self.makeFlatAPICall('getevents', params, function(data)
	{
		// Process the flat response into something usable.
		// data['events_count']: count of events in this response
		// The aspects are named 'events_N_aspect'
		var count = data['events_count'];
		
		var entries = {};
		for (var i=1; i <= count; i++)
		{
			var entry = {};
			entry.itemid = data['events_'+i+'_itemid'];
			entry.anum = data['events_'+i+'_anum'];
			entry.url = data['events_'+i+'_url'];
			entry.time = data['events_'+i+'_eventtime'];
			entry.subject = data['events_'+i+'_subject'];
			entry.body = unescape(data['events_'+i+'_event']);
			entry.properties = {};
			
			entries[entry.itemid] = entry;
		}
		
		var propcount = data['prop_count'];
		for (var i=1; i <= propcount; i++)
		{
			// prop_264_itemid, prop_264_name, prop_264_value
			var entry = entries[data['prop_'+i+'_itemid']];
			entry.properties[data['prop_'+i+'_name']] = data['prop_'+i+'_value'];
		}
		
		result = []
		for (k in entries)
		{
			result.push(entries[k]);
		}
		
		callback(result);
	});
};

Account.prototype.fetchBatch = function(lastsync, callback)
{
	var self = this;
	
	self.getEventsSince(lastsync, function(entries)
	{
		var pending = entries.length;
		for (var i=0; i < entries.length; i++)
		{
			var entry = entries[i];

			if ((lastsync < entry.time) || (lastsync === ''))
				lastsync = entry.time;
		
			var location = url.parse(entry.url);
			var pieces = location.pathname.split('/');
			var basename = pieces[pieces.length - 1].replace('.html', '.json');
			var fname = path.join(self.postspath(), basename);

			logger.info('backing up entry '+basename);
			fs.writeFile(fname, JSON.stringify(entry, null, true), 'utf8', function(err)
			{
				pending-- || callback(err, entries, lastsync);
			});
		}
		pending-- || callback(null, entries, lastsync);
	});
};

Account.prototype.fetchSyncItems = function(lastsync, count, callback)
{
	var self = this;
	self.fetchBatch(lastsync, function(err, entries, latest)
	{
		count += entries.length;
		lastsync = latest;
		callback(lastsync, count);
	});
};

Account.prototype.backupJournalEntries = function(callback)
{
	var self = this;
	logger.info('Fetching new and updated journal entries.');
	
	self.readLastSync(function(lastsync)
	{
		var previousSyncDate = lastsync;

		var recordResults = function(syncdata, newentries)
		{
			self.writeLastSync(syncdata, function()
			{
				logger.info("Local json archive complete.")
				if (previousSyncDate.length > 0)
					logger.info(newentries+' entries recorded since '+previousSyncDate +'.');
				else
					logger.info(newentries+' entries recorded.');
				callback();
			});
		};
		
		var lastrunsync = undefined;
		var continuer = function(syncdata, count)
		{
			if (syncdata === lastrunsync)
				recordResults(syncdata, count);
			else
			{
				lastrunsync = syncdata;
				self.fetchSyncItems(syncdata, count, continuer);
			}
		};
		self.fetchSyncItems(lastsync, 0, continuer);
	});
};

//------------------------------------------------------------------------------

Account.prototype.readLastSync = function(callback)
{
	var self = this;
	var pname = path.join(self.metapath(), 'last_sync.json');
	if (path.existsSync(pname))
	{
		fs.readFile(pname, 'utf8', function(err, data)
		{
			if (err) return callback(err);			
			lastsync = JSON.parse(data);
			return callback(lastsync);
		});		
	}
	else
		callback('');
}

Account.prototype.writeLastSync = function(lastsync, callback)
{
	var self = this;
	var pname = path.join(self.metapath(), 'last_sync.json');
	fs.writeFile(pname, JSON.stringify(lastsync), 'utf8', function(err)
	{
		if (err) return callback(err);			
		return callback(null);
	});		
}

//------------------------------------------------------------------------------

Account.prototype.fetchUserpicMetadata = function(callback)
{
	var self = this;
	var params = {
			'username': this.user,
			'ver': 1,
			'getpickws': 1,
			'getpickwurls': 1,
	};
	if (self.journal != self.user)
		params['usejournal'] = self.journal;

	self.makeFlatAPICall('login', params, function(response)
	{
		// parse LJ's data structures:
		// pickws == keywords
		// pickwurls == urls
		// Note that we're throwing away a lot of other data from the login response.
		var piccount = parseInt(response['pickwurl_count']);
		var userpics = []
		for (var i = 1; i < piccount+1; i++)
		{
			var hash = {};
			hash.tag = response['pickw_'+i];
			hash.url = response['pickwurl_'+i];
			userpics.push(hash);
		}
		var defaultpic = {};
		defaultpic.tag = 'default';
		defaultpic.url = response['defaultpicurl'];
		userpics.push(defaultpic);

		return callback(userpics);
	});
};

Account.prototype.cachedUserpicData = function(callback)
{
	var self = this;
	self.userpics = {};

	var pname = path.join(self.metapath(), 'userpics.json');
	if (!path.existsSync(pname))
		return callback(null);

	fs.readFile(pname, 'utf8', function(err, data)
	{
		if (err) return callback(err);			
		self.userpics = JSON.parse(data);
		logger.info('Read cached data from userpics.json.');
		return callback(null);
	});
};

function canonicalizeFilename(input)
{
	result = input.replace(/\//g, "+");
	result = result.replace('&', "+");
	result = result.replace(/\s+/g, '_');
	return result;
}

function fetchImage(pichash, callback)
{
	var uri = url.parse(pichash.url);
	new requester(uri).
		get().
		on('reply', function(response, body)
	{
		var mimetype = response.headers['content-type'];
		callback(pichash, mimetype, body);
	});
}

Account.prototype.fetchUserPics = function(callback)
{
	var self = this;
	logger.info('Recording userpic keyword info for ' + self.user)
	
	self.cachedUserpicData(function(err)
	{
		self.fetchUserpicMetadata(function(userpics)
		{
			logger.info('Retrieved userpic list from LJ.');
			var imgdir = self.journalPath() + '/userpics';
			
			var pending = 0;
			for (var i = 0; i < userpics.length; i++)
			{
				var previous = null;
				if (self.userpics[userpics[i].tag] !== undefined)
				{
					previous = self.userpics[userpics[i].tag];
					if ((previous.mimetype !== undefined) && (previous.filename !== undefined))
						continue;
				}
				logger.info('Fetching image for tag:' + userpics[i].tag)

				pending++;
				fetchImage(userpics[i], function(pichash, mimetype, data)
				{
					var suffix = mimetype.replace('image/', '');
					var imagefile = canonicalizeFilename(pichash.tag) + '.' + suffix;
					pichash.mimetype = mimetype;
					pichash.filename = imagefile;
					
					var fname = path.join(imgdir, imagefile);
					fs.writeFile(fname, data, 'binary', function(err)
					{
						if (err)
							logger.error('    failed to write '+pichash.filename);
						else
						{
							self.userpics[pichash.tag] = pichash;
							logger.info('    saved '+pichash.filename);
						}
						pending-- || callback();
					});
				});
			}
			pending-- || callback();
		});		
	});
};

Account.prototype.backupUserPics = function(callback)
{
	var self = this;
	self.fetchUserPics(function()
	{
		var pname = path.join(self.metapath(), 'userpics.json');
		fs.writeFile(pname, JSON.stringify(self.userpics), 'utf8', function(err)
		{
			if (err) return callback(err);			
			return callback(null);
		});
	});
};

//------------------------------------------------------------------------------

var config = require('./config.yml').shift();
if (config.source.port === undefined)
	config.source.port = 80;

var account = new Account(config.source);

// set up logging
var loggername = account.journal + '.ljsnarf.log'
var logger = new (winston.Logger)({
	transports: [
		new (winston.transports.Console)({ colorize: true }),
		new (winston.transports.File)({ filename: loggername, level: 'info', timestamp: true, colorize: false })
	]
});

logger.info("---------- ljsnarf run started");
logger.info("Version: " + VERSION);
logger.info('Source account: ' + account.journal + '@' + account.host);

var bpath = account.journalPath();
if (!path.existsSync(bpath))
{
	var pieces = bpath.split('/');
	var subpath = '';
	for (var i = 0; i < pieces.length; i++)
	{
		subpath = path.join(subpath, pieces[i]);
		if (!path.existsSync(subpath)) fs.mkdirSync(subpath);
	}
}
if (!path.existsSync(account.postspath())) fs.mkdirSync(account.postspath());
if (!path.existsSync(account.metapath())) fs.mkdirSync(account.metapath());
if (!path.existsSync(account.userpicspath())) fs.mkdirSync(account.userpicspath());

var start = new Date();
account.backupUserPics(function(err)
{
	logger.info('userpic backup complete.');
	account.backupJournalEntries(function()
	{
		var elapsed = (new Date() - start)/1000;
		logger.info(util.format('Done; %d seconds elapsed.', elapsed));
	});
});
