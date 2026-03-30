# Production Dockerfile for Azure Container Service
# Optimized for Azure Container Registry deployment

FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive \
    PYTHONPATH=/app

# Install system dependencies (optimized for faster builds)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libpq-dev \
    postgresql-client \
    portaudio19-dev \
    libasound2-dev \
    libportaudio2 \
    libssl-dev \
    libffi-dev \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app user for security (non-root)
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app /app/logs /app/media /app/static && \
    chown -R appuser:appuser /app

# Set working directory
WORKDIR /app

# Copy requirements first for better Docker layer caching
COPY --chown=appuser:appuser requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    # Install production server
    pip install --no-cache-dir gunicorn && \
    # Install Azure Key Vault SDK for secret management
    pip install --no-cache-dir azure-identity azure-keyvault-secrets

# Copy application code
COPY --chown=appuser:appuser . .

# Copy and set up startup script
COPY --chown=appuser:appuser start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create .env file from environment variables at runtime
# This will be populated by Azure Container Apps environment variables
RUN touch /app/.env && chown appuser:appuser /app/.env

# Collect static files (Django)
RUN python manage.py collectstatic --noinput --clear || echo "Static files collection skipped"

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/health/ || exit 1

# Start application
CMD ["/bin/bash", "/app/start.sh"]
