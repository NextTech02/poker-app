@echo off
echo Starting Torneios Poker Development Servers...
echo.

echo Starting Backend (FastAPI)...
start cmd /k "cd backend && venv\Scripts\activate && uvicorn app.main:app --reload"

timeout /t 3

echo Starting Frontend (React)...
start cmd /k "cd frontend && npm start"

echo.
echo Development servers starting...
echo Backend: http://localhost:8000
echo Frontend: http://localhost:3000
echo API Docs: http://localhost:8000/docs
