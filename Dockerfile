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

# Create startup script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "================================="\n\
echo "Starting Django Application"\n\
echo "================================="\n\
\n\
# Wait for database to be ready (if using Azure Database for PostgreSQL)\n\
if [ ! -z "$DB_HOST" ]; then\n\
    echo "Waiting for database at $DB_HOST:$DB_PORT..."\n\
    until pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" 2>/dev/null; do\n\
        echo "Database is unavailable - retrying in 2 seconds..."\n\
        sleep 2\n\
    done\n\
    echo "Database is ready!"\n\
fi\n\
\n\
# Run Django migrations\n\
echo "Running database migrations..."\n\
python manage.py migrate --noinput\n\
\n\
# Create superuser if needed (only in non-production)\n\
if [ "$DJANGO_DEBUG" = "True" ]; then\n\
    echo "Debug mode: Creating superuser if not exists..."\n\
    python manage.py shell -c "from django.contrib.auth import get_user_model; User = get_user_model(); User.objects.filter(username='"'"'admin'"'"').exists() or User.objects.create_superuser('"'"'admin'"'"', '"'"'admin@example.com'"'"', '"'"'admin123'"'"')" 2>/dev/null || true\n\
fi\n\
\n\
echo "================================="\n\
echo "Starting Gunicorn Server"\n\
echo "================================="\n\
\n\
# Start Gunicorn with optimal settings for Azure\n\
exec gunicorn workorder_system.wsgi:application \\\n\
    --bind 0.0.0.0:8000 \\\n\
    --workers ${GUNICORN_WORKERS:-4} \\\n\
    --threads ${GUNICORN_THREADS:-2} \\\n\
    --worker-class gthread \\\n\
    --worker-tmp-dir /dev/shm \\\n\
    --timeout ${GUNICORN_TIMEOUT:-120} \\\n\
    --graceful-timeout 30 \\\n\
    --keep-alive 5 \\\n\
    --access-logfile - \\\n\
    --error-logfile - \\\n\
    --log-level ${LOG_LEVEL:-info} \\\n\
    --capture-output \\\n\
    --enable-stdio-inheritance\n\
' > /app/start.sh && chmod +x /app/start.sh

# Start application
CMD ["/bin/bash", "/app/start.sh"]
