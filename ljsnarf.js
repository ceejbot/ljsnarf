var 
	// argv        = require('optimist').argv,
	async       = require('async'),
	crypto      = require('crypto'),
	fs          = require('fs'),
	http        = require('http'),
	path        = require('path'),
	requester   = require('chainable-request').chainableRequest,
	url         = require('url'),
	util        = require('util'),
	winston     = require('winston'),
	xmlrpc      = require('xmlrpc');

require('js-yaml');

var VERSION = '0.1.2';
var USERAGENT = { 'User-Agent': 'ljmigrate ' + VERSION };

// lj's time format: 2004-08-11 13:38:00
var ljTimeFormat = '%Y-%m-%d %H:%M:%S';
var apipath = '/interface/xmlrpc';
var flatpath = '/interface/flat';

// set up logging
var logger = new (winston.Logger)({
	transports: [
		new (winston.transports.Console)({ colorize: true }),
		new (winston.transports.File)({ filename: 'ljmigrate.log', level: 'info', timestamps: true, colorize: false })
	]
});

//------------------------------------------------------------------------------
// array update/extend.
if (Object.prototype.extend === undefined)
{
	Object.prototype.extend = function(source)
	{
		for (var property in source)
		{
			if (source.hasOwnProperty(property))
				this[property] = source[property];
		}
		return this;
	};
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
// XML-RPC, challenge/response, and other LJ communication plumbing

Account.prototype.rpcclient = function()
{
	if (this.client === undefined)
	{
		this.client = xmlrpc.createClient({
				host: this.host,
				port: this.port,
				path: apipath
		});
	}
	return this.client;
};

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
			'user': self.user
		};
		callback(result);
	});
};

// Params must be a hash.
Account.prototype.makeFlatAPICall = function(method, params, callback)
{
	logger.info("making flat API call with mode: ", method);
	var self = this;
	this.doChallengeFlat(function(challenge)
	{
		params.extend(challenge);
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
// Ask for a challenge from the server & calculate a response.
// Return the response ready be used in the next API call.
Account.prototype.doChallenge = function(callback)
{
	var self = this;
	self.rpcclient().methodCall('LJ.XMLRPC.getchallenge', [], function (error, response)
	{
		var result = {
			'auth_method': 'challenge',
			'auth_challenge': response['challenge'],
			'auth_response': self.respondToChallenge(response['challenge'])
		};
		callback(result);
	});
};

// Params must be a hash.
Account.prototype.makeRPCCall = function(method, params, callback)
{
	logger.info("calling LJ.XMLRPC."+method);
	var self = this;
	this.doChallengeFlat(function(challenge)
	{
		params.extend(challenge);
		self.rpcclient().methodCall('LJ.XMLRPC.' + method, [params], function (err, value)
		{
			callback(value);
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

//------------------------------------------------------------------------------

Account.prototype.getSyncItems = function(lastsync, callback)
{
	var self = this;
	var params = {
		'username': self.user,
		'ver': 1,
		'lastsync': '2011-10-02 15:32:31'
	};
	if ((lastsync.date !== undefined) && (lastsync.date.length > 0))
		syncdate = lastsync.date;
	else
		syncdate = '';

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
		
		var params = {
			mode : 'syncitems',
			ver: 1,
			lastsync: syncdate,
			user : self.user,
			auth_method: 'challenge',
			auth_challenge: challenge,
			auth_response: challengeResponse
		};
		self.requester().
			content_type('application/x-www-form-urlencoded').
			body(params).
			post('/interface/flat').
			on('reply', function(response, body)
		{
			data = self.handleFlatResponse(body);

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
	})	

};

Account.prototype.getOneEvent = function(itemid, callback)
{
	var self = this;
	itemid = itemid.replace(/^L-/, '');
	itemid = itemid.replace(/^C-/, '');

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
		
		if ((itemid.slice(0, 2) == 'L-') || (itemid.slice(0, 2) == 'C-'))
			itemid = itemid.slice(2, -1);
		
		var params = {
			mode : 'getevents',
			username: self.user,
			user: self.user,
			ver: 1,
			selecttype: "one",
			itemid: itemid,
			auth_method: 'challenge',
			auth_challenge: challenge,
			auth_response: challengeResponse
		};
		self.requester().
			content_type('application/x-www-form-urlencoded').
			body(params).
			post('/interface/flat').
			on('reply', function(response, body)
		{
			data = self.handleFlatResponse(body);
			callback(null, data);
		});
	})	

};

Account.prototype.fetchItem = function(item, callback)
{
	var self = this;
	// logger.debug('fetching item:', item);
	self.getOneEvent(item.id, function(err, data)
	{
		// Process the flat response into something usable.
		// event.events_count: count of events in this response; always 1
		// the aspects are named 'events_N_aspect'
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
	
		var location = url.parse(entry.url);
		var pieces = location.pathname.split('/');
		var basename = pieces[pieces.length - 1].replace('.html', '.json');
		var fname = path.join(self.postspath(), basename);
		fs.writeFile(fname, JSON.stringify(entry, null, true), 'utf8', function(err)
		{
			logger.info('wrote entry '+basename);
			callback(err, entry);
		});		
	});
};

Account.prototype.fetchSyncItems = function(lastsync, count, callback)
{
	var self = this;
	logger.info("fetching sync items starting with " + JSON.stringify(lastsync));
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
		
		var pending = -1;
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
				if (lastsync.date < item.time) lastsync.date = item.time;
				pending-- || callback(lastsync, count, totalToFetch - syncitems.length);
			});
		}
	});
};

Account.prototype.backupJournalEntries = function(callback)
{
	var self = this;
	logger.info('Fetching new and updated journal entries.');
	
	self.readLastSync(function(lastsync)
	{
		var previousSyncDate = lastsync.date;

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
		
		var continuer = function(syncdata, count, remaining, callback)
		{
			if (remaining <= 0)
				return recordResults(syncdata, count);
			self.fetchSyncItems(syncdata, count, continuer);
		};		
		self.fetchSyncItems(lastsync, 0, continuer);
	});
};



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
		// Note that we're throwing away a lot of other data from the login
		// response.
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
		logger.info('read userpics.json');
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
	logger.info('Recording userpic keyword info for:' + self.user)
	
	self.cachedUserpicData(function(err)
	{
		self.fetchUserpicMetadata(function(userpics)
		{
			logger.info('parsing userpic keywords from LJ');
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
		callback({ date: '', maxid: 0 });
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


//------------------------------------------------------------------------------

var config = require('./config.yml').shift();
if (config.source.port === undefined)
	config.source.port = 80;

var account = new Account(config.source);
logger.info("---------- ljmigrate run started");
logger.info("Version: " + VERSION);
logger.info('source account: ' + account.journal + '@' + account.host);

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

async.parallel(
[
	// function(cb) { account.makeSession(cb) },
	function(cb) { account.backupUserPics(cb) },
	function(cb) { account.backupJournalEntries(cb) }
],
function(err, results)
{
	console.log(results);
	var elapsed = (new Date() - start)/1000;
	logger.info(util.format('Done; %d seconds elapsed.', elapsed));
});

