#!/bin/bash
set -e

echo "================================="
echo "Starting Django Application"
echo "================================="

# Wait for database to be ready (if using Azure Database for PostgreSQL)
if [ ! -z "$DB_HOST" ]; then
    echo "Waiting for database at $DB_HOST:$DB_PORT..."
    until pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" 2>/dev/null; do
        echo "Database is unavailable - retrying in 2 seconds..."
        sleep 2
    done
    echo "Database is ready!"
fi

# Run Django migrations
echo "Running database migrations..."
python manage.py migrate --noinput

# Create superuser if needed (only in non-production)
if [ "$DJANGO_DEBUG" = "True" ]; then
    echo "Debug mode: Creating superuser if not exists..."
    python manage.py shell -c "from django.contrib.auth import get_user_model; User = get_user_model(); User.objects.filter(username='admin').exists() or User.objects.create_superuser('admin', 'admin@example.com', 'admin123')" 2>/dev/null || true
fi

echo "================================="
echo "Starting Gunicorn Server"
echo "================================="

# Start Gunicorn with optimal settings for Azure
exec gunicorn workorder_system.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers ${GUNICORN_WORKERS:-4} \
    --threads ${GUNICORN_THREADS:-2} \
    --worker-class gthread \
    --worker-tmp-dir /dev/shm \
    --timeout ${GUNICORN_TIMEOUT:-120} \
    --graceful-timeout 30 \
    --keep-alive 5 \
    --access-logfile - \
    --error-logfile - \
    --log-level ${LOG_LEVEL:-info} \
    --capture-output \
    --enable-stdio-inheritance
