#!/bin/bash
# Render entrypoint script for Roundtable backend

set -e

echo "Starting Roundtable Backend..."
echo "Python version: $(python --version)"

# Ensure data directory exists
mkdir -p data

# Check if Claude CLI is installed
if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code CLI..."
    curl -fsSL https://claude.ai/install.sh | sh
fi

# Add Claude to PATH
export PATH="$HOME/.local/bin:$PATH"

# Check Claude installation
if command -v claude &> /dev/null; then
    echo "✓ Claude Code CLI is available"
    claude --version
else
    echo "✗ Claude Code CLI not found in PATH"
    echo "Checking common locations..."
    ls -la ~/.local/bin/ 2>/dev/null || echo "~/.local/bin/ not found"
fi

# Run database migrations (tables auto-created)
echo "Database will be initialized automatically..."

# Start the application
echo "Starting Uvicorn server..."
exec uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1