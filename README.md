A very raw node.js tool for backing up a livejournal account to local files. Saves entries as .json files. Also retrieves userpics. It works but has about zero error handling so beware.

Requires [chainable-request](https://github.com/ceejbot/chainable-request) which as of the moment isn't in NPM, so snag it from there and npm link it.

```
cp config.yml.sample config.yml
vi config.yml
node ljsnarf.js
```

The results are saved in `backup/*hostname*/*account*/[posts,userpics]`.
