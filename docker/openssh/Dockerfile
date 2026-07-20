FROM alpine:3.22
RUN apk add --no-cache openssh coreutils findutils bash \
 && adduser -D -s /bin/bash tern \
 && mkdir -p /bench /home/tern/.ssh \
 && chmod 700 /home/tern/.ssh && chown -R tern:tern /home/tern/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
