FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends restic ca-certificates && rm -rf /var/lib/apt/lists/*
COPY infra/backup.sh /usr/local/bin/dachbyte-backup
RUN sed -i 's/\r$//' /usr/local/bin/dachbyte-backup && chmod 755 /usr/local/bin/dachbyte-backup
ENTRYPOINT ["/usr/local/bin/dachbyte-backup"]
