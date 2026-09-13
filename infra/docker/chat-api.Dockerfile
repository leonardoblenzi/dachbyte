FROM python:3.12-slim-bookworm
WORKDIR /app
COPY apps/business/chat/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/business/chat/backend/ ./
RUN useradd --uid 1000 --create-home dachbyte && mkdir -p /data/uploads && chown -R dachbyte /data
ENV PYTHONUNBUFFERED=1 UPLOAD_DIR=/data/uploads AUTO_MIGRATE_DB=false AUTO_SEED_USERS=false
USER dachbyte
CMD ["python", "-m", "uvicorn", "sordchat_fixed:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
