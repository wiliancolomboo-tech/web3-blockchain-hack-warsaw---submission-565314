curl -X POST http://localhost:8080/trigger-test-receipt \
     -H "Content-Type: application/json" \
     -d '{"escrowId": "84201", "amount": "500000000"}'