// Migration script to move data from news-data.json to MongoDB
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const News = require('./models/News').News;

async function migrate() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/jantakasandesh', {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✓ Connected to MongoDB');

        // Read existing JSON data
        let jsonData = [];
        if (fs.existsSync('news-data.json')) {
            const data = fs.readFileSync('news-data.json', 'utf8');
            jsonData = JSON.parse(data);
            console.log(`Found ${jsonData.length} news items in JSON file`);
        } else {
            console.log('No news-data.json file found. Starting with empty database.');
            await mongoose.disconnect();
            return;
        }

        if (jsonData.length === 0) {
            console.log('JSON file is empty. Nothing to migrate.');
            await mongoose.disconnect();
            return;
        }

        // Clear existing data (optional - comment out if you want to keep existing MongoDB data)
        await News.deleteMany({});
        console.log('✓ Cleared existing MongoDB data');

        // Insert data into MongoDB
        const newsItems = jsonData.map(item => ({
            heading: item.heading,
            content: item.content || '',
            category: item.category || 'desh',
            photo: item.photo || null,
            date: item.date ? new Date(item.date) : new Date(),
            formattedDate: item.formattedDate || new Date().toLocaleDateString('hi-IN', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            })
        }));

        await News.insertMany(newsItems);
        console.log(`✓ Successfully migrated ${newsItems.length} news items to MongoDB`);

        // Backup JSON file
        const backupName = `news-data.backup-${Date.now()}.json`;
        fs.copyFileSync('news-data.json', backupName);
        console.log(`✓ Created backup: ${backupName}`);

        console.log('\n✅ Migration completed successfully!');
        console.log('You can now start your server with: npm start');

        await mongoose.disconnect();
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

migrate();
