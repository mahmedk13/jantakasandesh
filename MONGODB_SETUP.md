# MongoDB Setup Guide for Janta Ka Sandesh

## Option 1: MongoDB Atlas (Recommended for Production - Free)

### Step 1: Create MongoDB Atlas Account
1. Go to https://www.mongodb.com/cloud/atlas/register
2. Sign up for free account
3. Create a new cluster (choose free M0 tier)

### Step 2: Configure Database Access
1. Go to "Database Access" in left menu
2. Click "Add New Database User"
3. Create username and password
4. Set permissions to "Read and Write to any database"

### Step 3: Configure Network Access
1. Go to "Network Access" in left menu
2. Click "Add IP Address"
3. Click "Allow Access from Anywhere" (0.0.0.0/0) for testing
4. Later, add only your server IP for security

### Step 4: Get Connection String
1. Click "Connect" on your cluster
2. Choose "Connect your application"
3. Copy the connection string
4. It looks like: `mongodb+srv://username:<password>@cluster0.xxxxx.mongodb.net/jantakasandesh?retryWrites=true&w=majority`
5. Replace `<password>` with your actual password
6. Replace `jantakasandesh` with your database name

### Step 5: Update .env File
```env
MONGODB_URI=mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/jantakasandesh?retryWrites=true&w=majority
```

## Option 2: Local MongoDB (For Development)

### Install MongoDB Locally
1. Download from https://www.mongodb.com/try/download/community
2. Install MongoDB
3. Start MongoDB service
4. Connection string: `mongodb://localhost:27017/jantakasandesh`

## Migration from JSON to MongoDB

Your existing news in `news-data.json` will need to be migrated. Run:
```bash
node migrate.js
```

## Testing the Connection

Start your server:
```bash
npm start
```

You should see: "✓ Connected to MongoDB"

## Deployment Notes

When deploying to production with jantakasandesh.in:

1. **Never commit .env file** - It's already in .gitignore
2. **Set environment variables** on your hosting platform (Heroku, Vercel, Railway, etc.)
3. **Use MongoDB Atlas** connection string
4. **Enable HTTPS** - Set NODE_ENV=production
5. **Restrict IP Access** in MongoDB Atlas to your server IP only

## Connection String Format

**MongoDB Atlas:**
```
mongodb+srv://username:password@cluster.mongodb.net/dbname
```

**Local MongoDB:**
```
mongodb://localhost:27017/dbname
```

## Troubleshooting

**Connection Failed?**
- Check username/password are correct
- Check IP is whitelisted in Atlas
- Check internet connection
- Verify connection string format

**Migration Issues?**
- Backup news-data.json first
- Check MongoDB is running
- Verify connection before migration
