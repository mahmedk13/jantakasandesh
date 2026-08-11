# Janta Ka Sandesh - News Website

A complete news website built with Node.js and Express where admins can add news articles with photos and public users can view them.

## Features

✓ **Admin Panel**
- Add news with heading and photo
- Preview images before uploading
- View all published news
- Delete news articles

✓ **Public Page**
- View all published news in a beautiful grid layout
- Responsive design works on all devices
- Auto-refresh every 30 seconds
- Hindi language support

✓ **Technical Features**
- Image upload with validation (max 5MB)
- File storage system
- REST API architecture
- Modern, responsive UI with Indian tricolor theme

## Installation

1. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

2. Open your browser:
   - **Public page**: http://localhost:3000
   - **Admin panel**: http://localhost:3000/admin

## How to Use

### Admin Panel (Add News)
1. Go to http://localhost:3000/admin
2. Enter news heading in Hindi or English
3. Select a photo (JPG, PNG, GIF, or WebP)
4. Preview the photo
5. Click "समाचार प्रकाशित करें" to publish
6. View all published news below the form
7. Delete news by clicking "हटाएं" button

### Public Page (View News)
1. Go to http://localhost:3000
2. All published news will be displayed automatically
3. News refreshes every 30 seconds
4. Latest news appears first

## Tech Stack

- **Backend**: Node.js, Express
- **File Upload**: Multer
- **Frontend**: HTML5, CSS3, JavaScript
- **Storage**: JSON file-based storage

## Project Structure

```
newswebsite/
├── public/
│   ├── admin.html      # Admin panel page
│   ├── index.html      # Public news page
│   └── styles.css      # Styling for all pages
├── uploads/            # Uploaded images (auto-created)
├── server.js           # Express server
├── news-data.json      # News data storage
└── package.json        # Dependencies
```

## API Endpoints

- `GET /` - Public homepage
- `GET /admin` - Admin panel
- `GET /api/news` - Get all news (JSON)
- `POST /api/news` - Add new news (requires heading and photo)
- `DELETE /api/news/:id` - Delete news by ID

## Notes

- Uploaded images are stored in the `uploads/` folder
- News data is stored in `news-data.json`
- Maximum image size: 5MB
- Supported image formats: JPEG, JPG, PNG, GIF, WebP
