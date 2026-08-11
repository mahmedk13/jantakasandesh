# Password Management Guide

## Change Password (For Logged-in Admins)

### Using Admin Panel
1. Login to admin panel: http://localhost:3000/admin
2. Scroll down to "🔒 पासवर्ड बदलें" section
3. Enter:
   - Current password
   - New password (min 6 characters)
   - Confirm new password
4. Click "Change Password"
5. **IMPORTANT:** Restart the server after changing password

### Manual Password Reset (If Locked Out)

If you forget your password or can't login:

1. **Open `.env` file** in your project folder
2. **Find this line:**
   ```
   ADMIN_PASSWORD=admin123
   ```
3. **Change to new password:**
   ```
   ADMIN_PASSWORD=yourNewPassword123
   ```
4. **Save the file**
5. **Restart server:**
   ```bash
   npm start
   ```
6. Login with new password

## Why No "Forgot Password" Feature?

"Forgot Password" typically requires:
- Email sending capability (SMTP setup)
- Email service costs or configuration
- Password reset token system
- Additional security infrastructure

**For a single-admin news website**, this is unnecessary complexity because:
- You have direct access to the server files
- You can manually change password in `.env` file
- No need for email verification

## Production Recommendations

When deploying to **jantakasandesh.in**:

1. **Use Strong Password:**
   - At least 12 characters
   - Mix of letters, numbers, symbols
   - Example: `JantaKa@2026$ecure`

2. **Keep .env File Secure:**
   - Never commit to GitHub
   - Store backup in secure location
   - Use environment variables on hosting platform

3. **Optional: Add Email Reset** (If needed later)
   - Use services like SendGrid, Mailgun
   - Add email field to admin account
   - Implement token-based reset

## Quick Password Recovery Steps

**If you're locked out:**
```bash
# Step 1: Open .env file
notepad .env

# Step 2: Change ADMIN_PASSWORD line
ADMIN_PASSWORD=newpass123

# Step 3: Save and restart
npm start
```

That's it! You're back in.

## Security Tips

1. **Don't share password**
2. **Change default password immediately**
3. **Use unique password (not used elsewhere)**
4. **Write down and store securely offline**
5. **Change password every 3-6 months**
