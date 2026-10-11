# Schema plan

The planned PostgreSQL model includes:

- `users`: customer and administrator accounts
- `events` and categories
- `venues` and `seats`
- `schedules` for event times and seating availability
- `bookings` and booking line items
- `payments` and verification status
- `tickets` and QR-code references
- `reviews` and ratings
- `notifications` such as booking confirmation emails

Migrations, constraints, indexes, and the database access layer will be designed before database integration. No tables are created by the initial scaffold.

