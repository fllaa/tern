FROM alpine:3.22
RUN apk add --no-cache dropbear coreutils bash \
 && adduser -D -s /bin/bash tern \
 && mkdir -p /etc/dropbear /home/tern/.ssh \
 && chmod 700 /home/tern/.ssh && chown -R tern:tern /home/tern/.ssh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
