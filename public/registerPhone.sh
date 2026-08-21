#!/bin/bash
TOKEN="EAFnTTTOK5sYBSfkM9XoOoS8ZCHrSi14KaqUZBdUTveYiPMCVOZBKwKQZBN9aVUbCpohZCojiDCc4hIyadegzuuE7JTImRmPr1hc4lDSMkX6QFUJoWF1gAQFKNmKumVBHnDHT7sUQZBwAqEIjPeXUdh9INs1oIZCOPuugKGVKGgVHJWuPQRRwlUMqFzQ5XLz8QZDZD"
curl -X POST 'https://graph.facebook.com/v20.0/812378515295003/register' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "messaging_product": "whatsapp", "pin": "123456" }'