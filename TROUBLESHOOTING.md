# Troubleshooting Guide 🔧

## Issue: "Unable to start tournament"

### ✅ Checklist

1. **Is the backend running?**
   ```bash
   cd backend
   uvicorn app.main:app --reload
   ```
   You should see: `INFO: Uvicorn running on http://127.0.0.1:8000`

2. **Is the frontend running?**
   ```bash
   cd frontend
   npm start
   ```
   You should see: `Compiled successfully!`

3. **Did you run the database migration?**
   - Go to Supabase Dashboard → SQL Editor
   - Run `database_migration_v2.sql`
   - Should show: "Migration completed successfully!"

4. **Are environment variables set?**

   **Backend** (`backend/.env`):
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbG... (service_role key)
   SUPABASE_JWT_SECRET=your-jwt-secret
   FRONTEND_URL=http://localhost:3000
   ```

   **Frontend** (`frontend/.env`):
   ```env
   REACT_APP_API_URL=http://localhost:8000
   REACT_APP_SUPABASE_URL=https://xxxxx.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=eyJhbG... (anon/public key)
   ```

5. **Can you login?**
   - Go to `http://localhost:3000`
   - Use email/password from Supabase Auth
   - If login fails, check browser console (F12)

6. **Can you see the tournament?**
   - Go to Torneios page
   - You should see your tournament with "Pendente" badge
   - Click "Iniciar" button
   - Confirm the dialog

---

## Common Errors & Solutions

### Error: "Failed to fetch" or "Network Error"
**Cause:** Backend not running or wrong API URL

**Solution:**
1. Make sure backend is running on port 8000
2. Check `frontend/.env` has `REACT_APP_API_URL=http://localhost:8000`
3. Restart frontend after changing .env

### Error: "401 Unauthorized"
**Cause:** Not logged in or token expired

**Solution:**
1. Logout and login again
2. Check Supabase user exists in Auth dashboard
3. Verify `SUPABASE_JWT_SECRET` matches in backend

### Error: "404 Not Found"
**Cause:** Tournament doesn't exist or wrong ID

**Solution:**
1. Refresh the page
2. Check tournament exists in Supabase Table Editor → tournaments
3. Verify tournament has `id` field

### Error: "Tournament not found" when starting
**Cause:** Backend can't find tournament in database

**Solution:**
1. Check Supabase connection in backend
2. Verify `SUPABASE_SERVICE_KEY` is correct
3. Check backend logs for errors

### Button doesn't do anything when clicked
**Cause:** JavaScript error or missing onClick handler

**Solution:**
1. Open browser console (F12) → Console tab
2. Click the button again and see if errors appear
3. Make sure you have the latest code (refresh if needed)

---

## Testing Steps

### 1. Test Backend API
1. Go to: `http://localhost:8000/docs`
2. Find `PATCH /tournaments/{tournament_id}`
3. Click "Try it out"
4. Enter your tournament ID
5. Request body:
   ```json
   {
     "status": "active"
   }
   ```
6. Click "Execute"
7. Should get 200 response with updated tournament

### 2. Test Frontend
1. Open browser console (F12)
2. Go to Network tab
3. Click "Iniciar" button on tournament
4. Watch for PATCH request to `/tournaments/{id}`
5. Should show status 200 and response data

---

## Quick Test Workflow

**From scratch:**

1. **Start backend:**
   ```bash
   cd backend
   uvicorn app.main:app --reload
   ```

2. **Start frontend:**
   ```bash
   cd frontend
   npm start
   ```

3. **Login** at `http://localhost:3000`

4. **Create a player:**
   - Go to Jogadores
   - Click "Novo Jogador"
   - Name: "Test Player"
   - Save

5. **Create tournament:**
   - Go to Torneios
   - Click "Novo Torneio"
   - Fill in details
   - Save

6. **Start tournament:**
   - Find your tournament
   - Status should be "Pendente" (yellow badge)
   - Click "Iniciar" button
   - Confirm
   - Status should change to "Em Andamento" (green badge)

---

## Still Having Issues?

### Check Backend Logs
Look at the terminal where backend is running for error messages.

### Check Browser Console
Press F12, go to Console tab, look for red errors.

### Check Supabase Logs
Go to Supabase Dashboard → Logs → API to see database queries.

### Verify Data
1. Supabase Dashboard → Table Editor
2. Check `tournaments` table
3. Find your tournament
4. Verify `status` field changes from `pending` to `active`

---

## Need Fresh Start?

If everything is broken:

1. **Stop both servers** (Ctrl+C)
2. **Clear browser cache** (Ctrl+Shift+Delete)
3. **Logout from app**
4. **Restart backend**
5. **Restart frontend**
6. **Login again**
7. **Try creating a new tournament**

---

## Contact Points

- **API Documentation**: http://localhost:8000/docs
- **Frontend**: http://localhost:3000
- **Supabase Dashboard**: https://supabase.com/dashboard
- **Project Files**: Check `COMPLETE_SETUP_GUIDE.md`
