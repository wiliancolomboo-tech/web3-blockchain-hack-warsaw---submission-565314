# Verify Daemon Health
docker inspect --format='{{json .State.Health.Status}}' aegis-enterprise-daemon

# Stream Live On-Chain Settlement Logs
docker logs -f aegis-enterprise-daemon