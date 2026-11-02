# Query container health status
curl -i http://localhost:8080/healthz

# Response
# HTTP/1.1 200 OK
# Content-Type: application/json
# {"status":"OK","uptime":3842.12}

# Query Prometheus Metrics
curl http://localhost:8080/metrics

# Response
# # HELP processed_events_total Total events processed
# # TYPE processed_events_total counter
# processed_events_total 14