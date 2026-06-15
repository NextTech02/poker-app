#!/bin/bash
echo "Starting Torneios Poker Development Servers..."
echo ""

echo "Starting Backend (FastAPI)..."
cd backend
source venv/bin/activate
uvicorn app.main:app --reload &
BACKEND_PID=$!

sleep 3

echo "Starting Frontend (React)..."
cd ../frontend
npm start &
FRONTEND_PID=$!

echo ""
echo "Development servers running..."
echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:3000"
echo "API Docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop all servers"

# Trap Ctrl+C to kill both processes
trap "kill $BACKEND_PID $FRONTEND_PID" EXIT

wait
