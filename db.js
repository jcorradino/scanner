const dotenv = require('dotenv');
const path = require('path');

dotenv.config({path: path.join(__dirname, '.env')});

const { MongoClient } = require('mongodb');

const uri = `mongodb+srv://${process.env.dbuser}:${process.env.dbpass}@${process.env.dbloc}`;
const dbName = 'scanner';  // Database name

let client;
let db;

async function connectDB() {
    if (client && client.topology && client.topology.isConnected()) {
        return db;
    }
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    return db;
}

module.exports = connectDB;