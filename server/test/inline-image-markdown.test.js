const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = require('./test-data-dir');
const { snapshotInlineImages } = require('#server/inline-image-markdown');
const { InlineImageStore, inlineImageStore } = require('#server/inline-image-store');
const { appendHistory, appendHistoryBulk, getHistory, onInlineImagesSaved, waitForInlineImageSnapshots, truncateConversationHistory } = require('#server/session-store');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const source = path.join(root, 'image (original).png');
fs.writeFileSync(source, png);
/** @param {string} text */
const snapshotUris = text => [...text.matchAll(/socketagent:\/\/image\?id=[a-f0-9-]+&name=[a-z.]+/g)].map(match => match[0]);

test('plain image paths and URL arrays are captured without agent tools', async () => {
  const store = new InlineImageStore(path.join(root, 'parser'));
  const web = http.createServer((req, res) => res.end(png));
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  try {
    const address = web.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/image.png`;
    const input = `First paragraph.\n\n![Screen](<${source}>)\n\nMiddle.\n\n\`\`\`socketagent-compare\n${JSON.stringify([source, url])}\n\`\`\`\n\nLast paragraph.`;
    const result = await snapshotInlineImages(input, 'session', store);
    const uris = snapshotUris(result);
    assert.equal(uris.length, 3);
    assert.equal(uris[0], uris[1]);
    assert.ok(result.startsWith('First paragraph.'));
    assert.ok(result.endsWith('Last paragraph.'));
    for (const uri of uris) assert.deepEqual(fs.readFileSync(store.resolve(uri)), png);
    assert.ok(!result.includes(url));
  } finally { await new Promise(resolve => web.close(resolve)); }
});

test('ordinary code and inline code stay literal; labels and parentheses survive', async () => {
  const store = new InlineImageStore(path.join(root, 'code'));
  const image = `![Screen](${source.replaceAll(' ', '%20')})`;
  const literal = `\`![example](/missing.png)\`\n\n\`\`\`text\n${image}\n\`\`\`\n`;
  const result = await snapshotInlineImages(literal + `\n![Caption](<${source}> "Title")`, 'session', store);
  assert.ok(result.startsWith(literal));
  assert.equal(snapshotUris(result).length, 1);
  assert.ok(result.endsWith(' "Title")'));
});

test('history captures immediately, sends a positioned update and preserves native text', async () => {
  const input = `\`\`\`socketagent-compare\n${JSON.stringify({title:'Compare', images:[{src:source,label:'Before'}]})}\n\`\`\``;
  /** @type {{session:string,entry:import("#server/protocol").HistoryEntry}[]} */
  const messages = [];
  const unsubscribe = onInlineImagesSaved((session, entry) => messages.push({session,entry}));
  try {
    const entry = appendHistory('automatic-image-session', {role:'assistant', content:input, streamId:'image-stream', timestamp:new Date().toISOString()});
    // Mutation happens before the asynchronous persistence callback. Capture
    // must already own the old bytes when appendHistory returns.
    fs.writeFileSync(source, Buffer.concat([png, Buffer.from('changed')]));
    await waitForInlineImageSnapshots();
    const rendered = getHistory('automatic-image-session')[0];
    const uri = snapshotUris(rendered.content)[0];
    assert.deepEqual(fs.readFileSync(inlineImageStore.resolve(uri)), png);
    assert.equal(messages[0].entry.content, input);
    assert.equal(messages[0].entry.entryId, entry.entryId);
    assert.ok(messages[0].entry.revision > entry.revision);
    appendHistoryBulk('automatic-image-session', [{...entry, content:input}]);
    assert.equal(getHistory('automatic-image-session')[0].content, rendered.content);
    appendHistory('automatic-image-session', {...entry, content:input});
    await waitForInlineImageSnapshots();
    assert.equal(getHistory('automatic-image-session')[0].content, rendered.content);
    assert.equal(messages.length, 1);
  } finally { unsubscribe(); fs.writeFileSync(source, png); }
});

test('capture finishing after rewind never resurrects removed messages', async () => {
  let release = () => { throw new Error("Not initialized"); };
  /** @type {Promise<void>} */
  const received = new Promise(resolve => { release = resolve; });
  let respond = () => { throw new Error("Request not received"); };
  const web = http.createServer((req, res) => { respond = () => { res.end(png); }; release(); });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  try {
    const address = web.address();
    assert.ok(address && typeof address === "object");
    const anchor = appendHistory('rewind-images', {role:'user',content:'Prompt',uuid:'anchor',timestamp:new Date().toISOString()});
    appendHistory('rewind-images', {role:'assistant',content:`![Image](http://127.0.0.1:${address.port}/image.png)`,streamId:'later',timestamp:new Date().toISOString()});
    await received;
    truncateConversationHistory('rewind-images', anchor);
    respond();
    await waitForInlineImageSnapshots();
    assert.ok(getHistory('rewind-images').every(entry => entry.role !== 'assistant'));
  } finally { await new Promise(resolve => web.close(resolve)); }
});
