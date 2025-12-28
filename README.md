# Family Chore Tracker 🏠✨

A beautiful and interactive chore tracking app for families with daily rotations, weekly chores, points system, team competitions, and leaderboards!

## Features

- 👥 Multiple user logins (kids and parents)
- 📅 Automatic daily chore rotations
- 🎯 Weekly chore assignments
- 🏆 Points system with leaderboards
- 👫 Team competitions (rotating every week)
- 🔥 Streak tracking
- ✅ Easy chore completion tracking
- 📝 Custom tasks and notes
- 📊 Monthly competitions

## Quick Start - Testing Locally

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run the development server:**
   ```bash
   npm run dev
   ```

3. **Open in your browser:**
   - Visit: `http://localhost:5173`

## Default Login Credentials

### Kids:
- Nicholas: `nick123`
- Emilie: `emilie123`
- Carter: `carter123`
- Cole: `cole123`
- Finn: `finn123`
- Liam: `liam123`

### Parents:
- Mom: `mom123`
- Dad: `dad123`

## Deploy to Vercel (FREE) 🚀

### Step 1: Push to GitHub

1. **Create a new repository on GitHub:**
   - Go to github.com
   - Click "New repository"
   - Name it: `chore-tracker` (or anything you like)
   - Don't initialize with README
   - Click "Create repository"

2. **Push your code to GitHub:**
   ```bash
   # Initialize git (if not already done)
   git init
   
   # Add all files
   git add .
   
   # Make your first commit
   git commit -m "Initial commit - Family Chore Tracker"
   
   # Add your GitHub repository as remote
   git remote add origin https://github.com/YOUR-USERNAME/chore-tracker.git
   
   # Push to GitHub
   git branch -M main
   git push -u origin main
   ```

### Step 2: Deploy on Vercel

1. **Go to Vercel:**
   - Visit: [vercel.com](https://vercel.com)
   - Click "Sign Up" (use GitHub login - easiest!)

2. **Import Your Project:**
   - Click "Add New..." → "Project"
   - Select "Import Git Repository"
   - Find your `chore-tracker` repository
   - Click "Import"

3. **Configure (Auto-detected):**
   - Framework Preset: Vite ✅ (auto-detected)
   - Build Command: `npm run build` ✅ (auto-detected)
   - Output Directory: `dist` ✅ (auto-detected)
   - Click "Deploy"

4. **Done! 🎉**
   - Wait ~2 minutes for build to complete
   - Your app is live at: `your-project-name.vercel.app`
   - Share the URL with your family!

### Step 3: Custom Subdomain (Optional)

1. In Vercel project settings → "Domains"
2. Change from random name to something like:
   - `johnson-chores.vercel.app`
   - `family-tasks.vercel.app`
   - `our-chores.vercel.app`

### Future Updates

After initial deployment, updates are automatic:
```bash
git add .
git commit -m "Updated chores"
git push
```
Vercel automatically rebuilds and deploys! ⚡

## Custom Domain (Optional - $10-15/year)

1. Buy a domain (e.g., `familychores.com`) from:
   - Namecheap, Porkbun, or Google Domains

2. In Vercel:
   - Go to project Settings → Domains
   - Click "Add"
   - Enter your domain
   - Follow DNS instructions from Vercel

3. Update DNS at your domain registrar
   - Usually takes 5-10 minutes to activate

## Customization

Edit `src/App.jsx` to customize:
- User names and passwords (line 5-14)
- Chore rotations (line 17-60)
- Weekly chores (line 62-68)
- Point values (line 75-81)
- Team configurations (line 83-119)

## Need Help?

- **Vercel Documentation:** [vercel.com/docs](https://vercel.com/docs)
- **React + Vite Guide:** [vitejs.dev/guide](https://vitejs.dev/guide)

## Tech Stack

- ⚛️ React 18
- ⚡ Vite
- 🎨 Tailwind CSS (via CDN)
- 🎯 Lucide React Icons

---

Built with ❤️ for families who want to make chores fun!
