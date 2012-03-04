A very raw node.js tool for backing up a livejournal account to local files. Saves entries as .json files. Also retrieves userpics. It works but has minimal error handling so it won't be resilient if LJ is having one of its more robust moments. 

I am aware of one bug: it doesn't correctly detect if there are "edit" syncitems after its current batch of new items, so on the first run it will decide that it's done slightly early. Subsequent runs fetch items one at a time using syncitems/getevent, so run it twice the very first time you back up a journal.

Requires [chainable-request](https://github.com/ceejbot/chainable-request) which as of the moment isn't in NPM, so snag it from there and npm link it. Or install it from the url.

```
cp config.yml.sample config.yml
vi config.yml
node ljsnarf.js
```

The results are saved in `backup/<hostname>/<account>/[posts,userpics]`.
