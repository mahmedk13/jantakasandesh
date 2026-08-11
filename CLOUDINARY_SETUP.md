# Cloudinary Setup Guide

Cloudinary provides free cloud storage for images. Follow these steps:

## Step 1: Create Cloudinary Account

1. Go to https://cloudinary.com/users/register/free
2. Sign up for a free account
3. Verify your email

## Step 2: Get Your Credentials

1. After login, go to Dashboard: https://cloudinary.com/console
2. You'll see your credentials:
   - **Cloud Name** (e.g., `dxxxxxx`)
   - **API Key** (e.g., `123456789012345`)
   - **API Secret** (e.g., `abcdefghijklmnopqrst`)

## Step 3: Update .env File

Copy your credentials and update `.env` file:

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name_here
CLOUDINARY_API_KEY=your_api_key_here
CLOUDINARY_API_SECRET=your_api_secret_here
```

**Example:**
```env
CLOUDINARY_CLOUD_NAME=dxxxxxx
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=abcdefghijklmnopqrst
```

## Step 4: Restart Server

After updating .env, restart your server:
```bash
npm start
```

## What Changed?

✅ **Before:** Photos saved in `uploads/` folder (local only)
❌ **Problem:** Photos not accessible when deployed globally

✅ **After:** Photos saved to Cloudinary (cloud storage)
✅ **Benefit:** Photos accessible from anywhere in the world

## Free Tier Limits

- **Storage:** 25GB
- **Bandwidth:** 25GB/month
- **Transformations:** 25,000/month
- More than enough for a news website!

## Verification

After adding a news article with photo:
1. Photo URL will look like: `https://res.cloudinary.com/YOUR_CLOUD_NAME/image/upload/v1234567890/janta-ka-sandesh/abc123.jpg`
2. Check your Cloudinary dashboard to see uploaded images
3. All photos will be in folder: `janta-ka-sandesh`

## Important Notes

- Images are automatically optimized (max 1200x800)
- Old local photos in `uploads/` folder will remain but won't be used
- All new photos go to Cloudinary
- When you delete a news article, the photo is automatically deleted from Cloudinary
