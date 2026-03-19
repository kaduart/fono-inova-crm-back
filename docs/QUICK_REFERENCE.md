# Fono-Inova Backend - Quick Reference Guide

## At a Glance
- **Framework**: Express.js + Node.js (ES6 Modules)
- **Database**: MongoDB (Atlas) with Mongoose
- **Cache/Queue**: Redis + BullMQ
- **Real-time**: Socket.IO
- **Code Stats**: 174 JS files, ~22,494 LOC
- **Entry Point**: `server.js` (port 5000)

---

## Directory Map

| Directory | Purpose | Key Files | Count |
|-----------|---------|-----------|-------|
| `routes/` | API endpoints | appointment.js (1,397 LOC), Payment.js (2,107 LOC) | 23 |
| `controllers/` | Request handlers | therapyPackageController, followupController | 10 |
| `services/` | Business logic | aiAmandaService, syncService, responseTrackingService | 24 |
| `models/` | Data schemas | Patient, Appointment, Payment, Leads, etc. | 29 |
| `middleware/` | Filters/validators | auth.js, errorHandler, conflictDetection | 13 |
| `config/` | Setup files | bullConfig, socket, redisConnection | 6 |
| `workers/` | Background jobs | followup.worker, followup.cron | 3 |
| `crons/` | Scheduled tasks | responseTracking.cron | 1 |

---

## Core Models (29 Total)

### Patient Management
- **Patient** - Patient records
- **Doctor** - Healthcare providers
- **Specialty** - Medical specialties

### Appointments & Sessions
- **Appointment** - Bookings (1,397 LOC in route)
- **Session** - Billable therapy sessions
- **Package** - Therapy packages
- **Evolution** - Patient progress notes

### Financial
- **Payment** - Transactions (2,107 LOC in route)
- **Package** - Payment status tracking

### Lead Management
- **Leads** - Prospect records
- **Followup** - Lead followups
- **FollowupAnalytics** - Metrics

### Reports & Documents
- **MedicalReport**, **SchoolReport**, **AnamnesisReport**
- **MedicalEvent** - Event synchronization

### Administrative
- **User**, **Admin**, **Contact**, **Message**, **Log**
- **ChatContext**, **Metric**, **Prescription**

---

## API Routes (23 Endpoints)

```
POST   /api/auth/login           - User authentication
POST   /api/signup               - New user registration
GET    /api/doctors              - Doctor list
POST   /api/appointments         - Create appointment
GET    /api/appointments/:id     - Get appointment details
PUT    /api/appointments/:id     - Update appointment
DELETE /api/appointments/:id     - Cancel appointment
GET    /api/patients             - Patient list
GET    /api/payments             - Payment records
POST   /api/payments             - Create payment
GET    /api/leads                - Lead management
POST   /api/followups            - Followup tracking
GET    /api/packages             - Therapy packages
POST   /api/pix/webhook          - PIX payment webhook
POST   /api/whatsapp/webhook     - WhatsApp webhook
GET    /api/admin/queues         - BullMQ dashboard
```

---

## Key Technologies & Integrations

### Payment (PIX)
- **Provider**: Sicoob Bank
- **File**: `services/sicoobService.js`
- **Webhook**: `/api/pix/webhook`
- **Status**: Production ready

### Messaging
- **WhatsApp**: `services/whatsappService.js`
- **Email**: SendGrid + Nodemailer
- **Real-time**: Socket.IO

### AI/Intelligence
- **Provider**: OpenAI GPT
- **Services**: 
  - Lead qualification (`leadIntelligence.js`)
  - Smart responses (`smartFollowup.js`)
  - Objection handling (`objectionHandler.js`)
  - Context memory (`contextMemory.js`)

### Marketing
- **Google Ads**: Campaign integration
- **Google Analytics**: GA4 tracking

### Queue & Scheduling
- **BullMQ**: Job processing
- **Redis**: Cache & queue persistence
- **Node-Cron**: Scheduled tasks

---

## Authentication & Authorization

**Type**: JWT (JSON Web Tokens)

**Roles**:
- `admin` - Full access
- `secretary` - Staff operations
- `doctor` - Professional operations
- `patient` - Patient operations

**Middleware**: `middleware/auth.js`
```javascript
// Token location: Authorization header or cookies
Authorization: Bearer <token>
```

---

## Database Schema Relationships

```
Patient
├── appointments[] → Appointment
├── packages[] → Package
├── lastAppointment (virtual)
└── nextAppointment (virtual)

Appointment
├── patient → Patient
├── doctor → Doctor
├── payment → Payment
├── package → Package
└── session → Session

Payment
├── patient → Patient
├── doctor → Doctor
├── appointment → Appointment
├── package → Package
└── session → Session

Leads
├── owner → User
├── interactions[] (embedded)
└── convertedToPatient → Patient

Doctor
├── specialty → Specialty
├── appointments[] → Appointment
└── packages[] → Package
```

---

## Important Configuration Files

| File | Purpose |
|------|---------|
| `server.js` | App initialization, middleware setup, route registration |
| `config/bullConfig.js` | BullMQ queue setup |
| `config/socket.js` | Socket.IO configuration |
| `config/redisConnection.js` | Redis client setup |
| `models/index.js` | Model exports |
| `package.json` | Dependencies, scripts |
| `.env` | Secrets & configuration (never commit) |

---

## Environment Variables Required

```bash
# Database
MONGO_URI=mongodb+srv://...

# Server
PORT=5000
NODE_ENV=development
JWT_SECRET=...

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=...

# External APIs
OPENAI_API_KEY=...
SICOOB_CLIENT_ID=...
SICOOB_CLIENT_SECRET=...

# WhatsApp
PHONE_NUMBER_ID=...

# Email
SENDGRID_API_KEY=...
EMAIL_DEV_PASS=...

# Google
GOOGLE_*=...
```

---

## File Size Analysis

### Largest Files (Need Refactoring)
1. **Payment.js** (routes) - 2,107 LOC
2. **appointment.js** (routes) - 1,397 LOC
3. **therapyPackageController.js** - Large controller
4. **responseTrackingService.js** - 29KB
5. **aiAmandaService.js** - 21KB
6. **syncService.js** - 13KB

**Recommendation**: Break into smaller, focused files following SOLID principles.

---

## Startup Sequence

1. Load `.env` → dotenv
2. Set timezone to `America/Sao_Paulo`
3. Initialize Express app & HTTP server
4. Configure Socket.IO
5. Apply middleware (Helmet, CORS, auth)
6. Connect Redis → health check
7. Connect MongoDB
8. Load workers & crons
9. Register API routes
10. Start server on port 5000

---

## Testing & Quality Tools

**Currently Installed**:
- winston (^3.17.0) - Logging (underutilized)
- dotenv (^16.6.1) - Config
- helmet (^8.1.0) - Security
- cors (^2.8.5) - CORS

**Missing**:
- Jest/Mocha - No tests found
- TypeScript - No type safety
- Swagger/OpenAPI - No API docs
- ESLint - No code linting
- Prettier - No code formatting

---

## Code Quality Summary

### Strengths ✓
- Layered architecture (routes → controllers → services → models)
- Comprehensive models with validation
- Global error handling
- Security hardening (JWT, Helmet, CORS, bcrypt)
- Asynchronous job processing
- Real-time capabilities
- Database hooks for consistency

### Weaknesses ✗
- Large monolithic route files (need splitting)
- Missing unit/integration tests
- No TypeScript for type safety
- Limited API documentation
- Inconsistent error responses
- Minimal structured logging usage
- No database transactions
- Missing input validation schemas

---

## Quick Commands

```bash
# Start server
npm start

# Development with auto-reload
npm start (with nodemon installed)

# View job queue
http://localhost:5000/admin/queues

# Health check
curl http://localhost:5000/health

# Check Redis connection
redis-cli PING
```

---

## Next Steps for Code Quality Analysis

1. **Code Review Focus Areas**:
   - appointment.js & Payment.js route organization
   - therapyPackageController refactoring
   - Error handling consistency
   - Database transaction patterns

2. **Recommended Improvements**:
   - Split large route files
   - Add comprehensive error handling
   - Implement input validation (joi/zod)
   - Add unit tests (jest)
   - TypeScript migration plan
   - API documentation (Swagger)
   - Structured logging (Winston)

