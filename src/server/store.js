// Storage layer. Two backends share one tiny async interface:
//   - MongoStore: MongoDB Atlas via MONGODB_URI (production path from the plan)
//   - JsonStore:  a JSON file, used when MONGODB_URI is not set (local dev / tests)
// Filters are plain equality objects, e.g. { siteId: 'x', pageId: null }.
import fs from 'node:fs';
import path from 'node:path';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const match = (doc, filter = {}) => Object.entries(filter).every(([k, v]) => (v === null ? doc[k] == null : doc[k] === v));

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    if (file && fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.kind = 'json';
  }
  async connect() {}
  async close() { this.flush(); }
  async find(col, filter = {}) { return (this.data[col] || []).filter((d) => match(d, filter)).map(clone); }
  async findOne(col, filter = {}) { return (await this.find(col, filter))[0] || null; }
  async insertMany(col, docs) { if (!docs.length) return; (this.data[col] ||= []).push(...docs.map(clone)); this.save(); }
  async insertOne(col, doc) { return this.insertMany(col, [doc]); }
  async update(col, filter, patch) {
    let n = 0;
    for (const d of this.data[col] || []) if (match(d, filter)) { Object.assign(d, clone(patch)); n++; }
    if (n) this.save();
    return n;
  }
  async delete(col, filter) {
    const arr = this.data[col] || [];
    const keep = arr.filter((d) => !match(d, filter));
    this.data[col] = keep;
    if (keep.length !== arr.length) this.save();
    return arr.length - keep.length;
  }
  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

export class MongoStore {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.kind = 'mongodb';
  }
  async connect() {
    const { MongoClient } = await import('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000 });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    // Indexes from the plan's data model.
    await Promise.all([
      this.db.collection('users').createIndex({ email: 1 }, { unique: true }),
      this.db.collection('sites').createIndex({ subdomain: 1 }, { unique: true }),
      this.db.collection('sites').createIndex({ workspaceId: 1 }),
      this.db.collection('pages').createIndex({ siteId: 1, slug: 1, parentId: 1 }),
      this.db.collection('sections').createIndex({ siteId: 1, pageId: 1, order: 1 }),
      this.db.collection('siteVersions').createIndex({ siteId: 1, number: 1 }),
      this.db.collection('domains').createIndex({ host: 1 }, { unique: true }),
      this.db.collection('formSubmissions').createIndex({ siteId: 1, createdAt: -1 }),
    ]);
  }
  async close() { await this.client?.close(); }
  c(col) { return this.db.collection(col); }
  async find(col, filter = {}) { return this.c(col).find(filter).toArray(); }
  async findOne(col, filter = {}) { return this.c(col).findOne(filter); }
  async insertMany(col, docs) { if (docs.length) await this.c(col).insertMany(docs.map(clone)); }
  async insertOne(col, doc) { await this.c(col).insertOne(clone(doc)); }
  async update(col, filter, patch) { return (await this.c(col).updateMany(filter, { $set: clone(patch) })).matchedCount; }
  async delete(col, filter) { return (await this.c(col).deleteMany(filter)).deletedCount; }
}

export async function createStore({ dataFile } = {}) {
  const uri = process.env.MONGODB_URI;
  const store = uri
    ? new MongoStore(uri, process.env.MONGODB_DB || 'website_builder')
    : new JsonStore(dataFile);
  await store.connect();
  return store;
}
