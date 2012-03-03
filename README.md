A very raw node.js tool for backing up a livejournal account to local files. Saves entries as .json files. Also retrieves userpics. It works but has about zero error handling so it won't be resilient if LJ is having one of its more robust moments. 

I am aware of one bug: it doesn't correctly detect if there are "edit" syncitems after its current batch of new items, so it will decide that it's done slightly early. Running it twice will make it pick up any lurking unbacked-up edits, so it's not crippling.

Requires [chainable-request](https://github.com/ceejbot/chainable-request) which as of the moment isn't in NPM, so snag it from there and npm link it. Or install it from the url.

```
cp config.yml.sample config.yml
vi config.yml
node ljsnarf.js
```

The results are saved in `backup/*hostname*/*account*/[posts,userpics]`.
