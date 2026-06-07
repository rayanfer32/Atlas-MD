import "./Configurations.js";
import mongoose from "mongoose";
import chalk from "chalk";
import figlet from "figlet";

// Helper to mask password in MongoDB URI
function maskMongoUri(uri) {
  if (!uri) return "Not Configured";
  try {
    const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@.+)$/);
    if (match) {
      return `${match[1]}******${match[3]}`;
    }
    return uri;
  } catch (e) {
    return "Invalid/Malformed URI";
  }
}

async function testConnection() {
  console.clear();
  
  // Banner
  console.log(
    chalk.cyan(
      figlet.textSync("ATLAS DB TEST", {
        font: "Small",
        horizontalLayout: "default",
        verticalLayout: "default",
      })
    )
  );

  console.log(chalk.bold.blue("=================================================="));
  console.log(chalk.bold.blue("         MongoDB Connection Diagnostic Tool       "));
  console.log(chalk.bold.blue("=================================================="));
  console.log("");

  const rawUri = global.mongodb;
  const maskedUri = maskMongoUri(rawUri);

  console.log(`${chalk.yellow("▸")} Connection URI:   ${chalk.gray(maskedUri)}`);
  console.log(`${chalk.yellow("▸")} Timeout Limit:   ${chalk.gray("5 seconds")}`);
  console.log("");

  if (!rawUri || rawUri.startsWith("mongodb://localhost") && !process.env.MONGODB) {
    console.log(chalk.yellow("⚠️  Warning: MONGODB environment variable is not explicitly set in your .env."));
    console.log(chalk.yellow("   Falling back to default local URI: mongodb://localhost:27017/atlas\n"));
  }

  console.log(chalk.cyan("⏳ Attempting to connect to the database..."));

  try {
    // We set serverSelectionTimeoutMS to 5000 so the script doesn't hang for 30s
    await mongoose.connect(rawUri, {
      serverSelectionTimeoutMS: 5000,
    });

    console.log(chalk.green("✔ Successfully connected to MongoDB!"));
    console.log("");

    console.log(chalk.cyan("⏳ Running database sanity checks..."));
    
    // Fetch database stats to verify full read/write/query capabilities
    const db = mongoose.connection.db;
    const adminDb = db.admin();
    
    // 1. Get database details
    const dbName = mongoose.connection.name;
    console.log(`${chalk.green("✔")} Database Name:     ${chalk.bold(dbName)}`);

    // 2. Fetch list of collections
    const collections = await db.listCollections().toArray();
    console.log(`${chalk.green("✔")} Collections Found: ${chalk.bold(collections.length)}`);
    if (collections.length > 0) {
      const names = collections.map(c => c.name).join(", ");
      console.log(chalk.gray(`   └─ Collections: ${names}`));
    }

    // 3. Ping command
    const pingResult = await adminDb.ping();
    console.log(`${chalk.green("✔")} Database Ping:     ${chalk.bold("Successful")}`);

    console.log("");
    console.log(chalk.bold.green("=================================================="));
    console.log(chalk.bold.green(" 🎉 Connection Test PASSED! Database is healthy.  "));
    console.log(chalk.bold.green("=================================================="));
    
  } catch (error) {
    console.log("");
    console.log(chalk.red("❌ Connection Test FAILED!"));
    console.log("");
    console.log(chalk.bold.red("Error Details:"));
    console.log(chalk.red(`   ${error.message}`));
    console.log("");

    console.log(chalk.bold.yellow("🔍 Troubleshooting Tips:"));
    
    if (error.message.includes("querySrv ETIMEOUT") || error.message.includes("querySrv ENOTFOUND")) {
      console.log(chalk.yellow("   1. Domain Name Resolution Failed."));
      console.log("      - Check your internet connection.");
      console.log("      - Verify the spelling of your MongoDB Atlas cluster domain.");
    } else if (error.message.includes("ETIMEOUT") || error.message.includes("MongooseServerSelectionError")) {
      console.log(chalk.yellow("   1. Network Timeout / IP Whitelisting issue."));
      console.log("      - If using MongoDB Atlas, make sure your CURRENT IP address is whitelisted");
      console.log("        in the Atlas Dashboard under Security -> Network Access.");
      console.log("      - Set 'Access from Anywhere' (0.0.0.0/0) if testing from a dynamic IP/VPS.");
      console.log("      - Check if a firewall or VPN is blocking outbound connection on port 27017.");
    } else if (error.message.includes("Authentication failed") || error.message.includes("auth failed")) {
      console.log(chalk.yellow("   1. Invalid Credentials."));
      console.log("      - Verify that the username and password in the MONGODB URI are correct.");
      console.log("      - Ensure special characters in the password are URL-encoded (e.g., '@' as '%40').");
    } else {
      console.log(chalk.yellow("   1. Check MongoDB server status."));
      console.log("      - If running locally, make sure your MongoDB service is running: 'mongod'.");
      console.log("      - Verify the port number (default is 27017).");
    }
    
    console.log("");
    console.log(chalk.bold.red("=================================================="));
    process.exit(1);
  } finally {
    // Cleanly close mongoose connection
    await mongoose.disconnect();
  }
}

testConnection();
