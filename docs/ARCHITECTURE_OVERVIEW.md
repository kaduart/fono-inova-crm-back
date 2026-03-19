# Fono-Inova Backend - Codebase Architecture Overview

## Executive Summary
- **Type**: Node.js/Express REST API + Real-time WebSocket Server
- **Total Files**: 174 JavaScript files (excluding node_modules)
- **Total Lines of Code**: ~22,494 LOC
- **Language**: JavaScript (ES6 Modules)
- **Database**: MongoDB with Mongoose ODM
- **Cache/Queue**: Redis with BullMQ for job processing

---

## 1. Main Architecture & Framework

### Core Stack
| Component | Technology | Version |
|-----------|-----------|---------|
| **Runtime** | Node.js | - |
| **Framework** | Express.js | ^4.21.2 |
| **Database** | MongoDB | ^6.8.0 |
| **ODM** | Mongoose | ^8.6.2 |
| **Cache** | Redis | ^5.8.3 |
| **Job Queue** | BullMQ | ^5.61.0 |
| **Real-time** | Socket.IO | ^4.8.1 |
| **Security** | JWT, Helmet, CORS | JWT: ^9.0.2, Helmet: ^8.1.0 |

### Architecture Pattern
- **Style**: REST API with layered architecture
- **Entry Point**: `server.js` (main server initialization)
- **Module System**: ES6 Modules (`"type": "module"` in package.json)

### Key Architectural Features
1. **Asynchronous Job Processing**: BullMQ queues for background tasks (followups, analytics)
2. **Real-time Communication**: Socket.IO for WebSocket connections
3. **Cache Layer**: Redis for session management and caching
4. **Database Synchronization**: Custom syncService for event-driven data synchronization
5. **Authentication**: JWT-based token authentication with role-based access control
6. **AI Integration**: OpenAI API for intelligent lead handling and responses

---

## 2. Directory Structure & Organization

```
backend/
├── certs/                          # SSL/TLS certificates for PIX integration
├── config/                         # Configuration files
│   ├── bullConfig.js              # BullMQ queue configuration
│   ├── redisConnection.js         # Redis connection setup
│   ├── socket.js                  # Socket.IO initialization
│   ├── ga4-key.json               # Google Analytics 4 credentials
│   └── constants.js               # Application constants
├── controllers/                    # Business logic handlers (10 files)
│   ├── authController.js          # Authentication/Authorization logic
│   ├── leadController.js          # Lead management
│   ├── followupController.js      # Followup management
│   ├── whatsappController.js      # WhatsApp integration
│   ├── doctorController.js        # Doctor management
│   ├── therapyPackageController.js# Package management (largest: 59KB)
│   ├── sicoobController.js        # PIX payment integration
│   └── ...
├── crons/                         # Scheduled tasks
│   └── responseTracking.cron.js   # Response tracking automation
├── helpers/                       # Utility helper functions
├── jobs/                          # Job definitions
│   └── followup.analytics.cron.js # Analytics cron jobs
├── middleware/                    # Express middleware (13 files)
│   ├── auth.js                    # JWT authentication
│   ├── errorHandler.js            # Global error handling
│   ├── conflictDetection.js       # Appointment conflict detection
│   ├── rateLimiter.js             # Rate limiting
│   └── ...
├── models/                        # MongoDB schemas (29 files)
│   ├── Appointment.js             # Appointment model
│   ├── Patient.js                 # Patient model
│   ├── Payment.js                 # Payment model (largest: 7.9KB)
│   ├── Leads.js                   # Lead management model
│   ├── Doctor.js                  # Doctor model
│   ├── Package.js                 # Therapy package model
│   ├── Session.js                 # Session model
│   ├── Followup.js                # Followup model
│   ├── MedicalReport.js           # Medical reports
│   ├── SchoolReport.js            # Educational reports
│   ├── Payment.js                 # Payment tracking
│   └── ... (29 total)
├── routes/                        # API endpoints (23 route files)
│   ├── appointment.js             # Appointment endpoints (1,397 LOC - largest)
│   ├── Payment.js                 # Payment endpoints (2,107 LOC)
│   ├── admin.js                   # Admin endpoints (285 LOC)
│   ├── patient.js                 # Patient endpoints (374 LOC)
│   ├── auth.js                    # Authentication endpoints
│   ├── leads.js                   # Lead management
│   ├── followup.js                # Followup endpoints
│   ├── whatsapp.js                # WhatsApp endpoints
│   ├── google-ads.js              # Google Ads integration
│   ├── pix.js                     # PIX payment webhooks
│   └── ... (23 total)
├── services/                      # Business logic & external integrations (24 files)
│   ├── redisClient.js             # Redis client management
│   ├── syncService.js             # Data synchronization service (13KB)
│   ├── responseTrackingService.js # Response tracking (29KB)
│   ├── aiAmandaService.js         # AI assistant service (21KB)
│   ├── whatsappService.js         # WhatsApp API integration
│   ├── sicoobService.js           # PIX/Sicoob integration
│   ├── emailService.js            # Email sending service
│   ├── leadCircuitService.js      # Lead pipeline management
│   ├── paymentService.js          # Payment processing logic
│   ├── packageService.js          # Package operations
│   ├── analytics.js               # Analytics logic
│   ├── intelligence/              # AI/ML intelligence services (5 files)
│   │   ├── leadIntelligence.js    # Lead qualification & scoring
│   │   ├── smartFollowup.js       # Intelligent followup
│   │   ├── objectionHandler.js    # Handle lead objections
│   │   ├── contextMemory.js       # Conversation context
│   │   └── analytics.js           # Intelligence analytics
│   └── ... (24 total)
├── workers/                       # Background workers & cron jobs
│   ├── followup.worker.js         # Followup worker (BullMQ processor)
│   ├── followup.cron.js           # Followup cron scheduler
│   └── addJobTest.js              # Test utility
├── scripts/                       # Utility and data correction scripts
│   ├── corrections/               # Data correction scripts
│   └── relatorios/                # Report generation scripts
├── templates/                     # Email templates
├── types/                         # TypeScript type definitions (if any)
│   └── express/                   # Express type extensions
├── utils/                         # General utility functions
│   └── transactionRetry.js        # Transaction retry logic
├── server.js                      # Main entry point (256 LOC)
├── package.json                   # Dependencies manifest
└── .env                           # Environment configuration (NEVER COMMIT)
```

### File Organization Summary
- **Controllers**: 10 files - Handle HTTP request/response logic
- **Models**: 29 files - MongoDB schema definitions
- **Routes**: 23 files - API endpoint definitions
- **Services**: 24 files - Business logic and integrations
- **Middleware**: 13 files - Request processing pipeline
- **Workers/Crons**: 4 files - Scheduled and background tasks

---

## 3. Key Dependencies & Libraries

### Core Framework & HTTP
- **express** (^4.21.2) - Web framework
- **helmet** (^8.1.0) - Security headers
- **cors** (^2.8.5) - Cross-origin requests
- **express-rate-limit** (^8.1.0) - Rate limiting

### Database
- **mongoose** (^8.6.2) - MongoDB ODM
- **mongodb** (^6.8.0) - Native MongoDB driver

### Authentication & Security
- **jsonwebtoken** (^9.0.2) - JWT token management
- **bcrypt** (^5.1.1) - Password hashing
- **bcryptjs** (^3.0.2) - JavaScript bcrypt alternative

### Real-time & Messaging
- **socket.io** (^4.8.1) - WebSocket communication
- **socket.io-client** (^4.8.1) - WebSocket client
- **nodemailer** (^7.0.5) - Email sending
- **@sendgrid/mail** (^8.1.5) - SendGrid email service

### Job Processing & Scheduling
- **bullmq** (^5.61.0) - Redis-backed job queue
- **@bull-board/express** (^6.13.0) - BullMQ dashboard
- **node-cron** (^4.2.1) - Cron job scheduling

### Cache & Data Storage
- **redis** (^5.8.3) - Redis client
- **node-cache** (^5.1.2) - In-memory caching

### AI & External APIs
- **openai** (^6.5.0) - OpenAI API integration
- **google-ads-api** (^21.0.1) - Google Ads integration
- **googleapis** (^159.0.0) - Google APIs
- **@google-analytics/data** (^5.2.0) - Google Analytics 4

### Utilities
- **date-fns** (^4.1.0) - Date manipulation
- **date-fns-tz** (^3.2.0) - Timezone support
- **moment-timezone** (^0.6.0) - Alternative timezone handling
- **luxon** (^3.7.1) - Date/time library
- **qrcode** (^1.5.4) - QR code generation
- **pdfkit** (^0.17.1) - PDF generation
- **puppeteer** (^24.15.0) - Headless browser automation
- **ejs** (^3.1.10) - Template engine
- **winston** (^3.17.0) - Logging library
- **dotenv** (^16.6.1) - Environment variable management

### Development
- **nodemon** (^3.1.10) - Auto-reload on file changes
- **@types/socket.io** (^3.0.1) - Socket.IO type definitions

---

## 4. Main Entry Point & Routing Structure

### Server Initialization Flow (`server.js`)

**Startup Sequence:**
1. **Load Environment Variables** - dotenv configuration
2. **Set Timezone** - America/Sao_Paulo
3. **Initialize Core Services**:
   - Express app
   - HTTP server
   - Socket.IO initialization
4. **Configure Middleware**:
   - Helmet (security headers)
   - CORS (configured for specific origins)
   - JSON parsing
   - Logging middleware
5. **Register API Routes** (23 routes):
   ```
   /api/auth           - Authentication
   /api/signup         - User registration
   /api/login          - Login
   /api/admin          - Admin operations
   /api/doctors        - Doctor management
   /api/patients       - Patient management
   /api/appointments   - Appointment booking
   /api/evolutions     - Patient evolution notes
   /api/leads          - Lead management
   /api/packages       - Therapy packages
   /api/payments       - Payment processing
   /api/users          - User management
   /api/specialties    - Medical specialties
   /api/analytics      - Analytics data
   /api/google-ads     - Google Ads integration
   /api/amanda         - AI assistant
   /api/reports        - Report generation
   /api/pix            - PIX payment webhooks
   /api/whatsapp       - WhatsApp integration
   /api/followups      - Followup management
   /api/marketing      - Marketing campaigns
   ```
6. **Initialize Background Services**:
   - Redis connection
   - MongoDB connection
   - BullMQ followupQueue
   - Cron jobs:
     - `followup.worker.js` - Followup processing
     - `followup.cron.js` - Followup scheduling
     - `followup.analytics.cron.js` - Analytics aggregation
     - `responseTracking.cron.js` - Response tracking
7. **Socket.IO Watchers**:
   - Mongoose change streams for real-time updates
   - WhatsApp message events
   - Appointment updates

### Allowed CORS Origins
```javascript
[
  "https://app.clinicafonoinova.com.br",
  "https://fono-inova-crm-front.vercel.app",
  "http://localhost:5000",
  "http://localhost:5173"
]
```

### API Route Sizes (LOC)
| Route | Size (LOC) | Purpose |
|-------|-----------|---------|
| appointment.js | 1,397 | Appointment CRUD + sync |
| Payment.js | 2,107 | Payment processing + distribution |
| admin.js | 285 | Admin operations |
| patient.js | 374 | Patient management |
| therapyPackageController | Large | Package operations |
| Other routes | < 100 | Specialized endpoints |

### Authentication & Authorization
- **Middleware**: `middleware/auth.js`
- **Method**: JWT (Bearer token in Authorization header or cookies)
- **Roles**: admin, secretary, doctor, patient
- **Middleware**: `authorize()` for role-based access control

---

## 5. Database Models & Connections

### MongoDB Connection
- **Host**: MongoDB Atlas (cloud-hosted)
- **URI Pattern**: mongodb+srv://user:pass@cluster.mongodb.net/database
- **Connection Method**: Mongoose (automatic connection pooling)
- **Health Check**: Redis PING every 5 minutes

### Core Data Models (29 Total)

#### Core Domain Models
| Model | Purpose | Key Fields |
|-------|---------|-----------|
| **Patient** | Patient records | fullName, DOB, doctor, phone, email, CPF, address, health plan |
| **Doctor** | Healthcare provider | name, specialty, schedule, availability |
| **Appointment** | Session booking | patient, doctor, date, time, status (operational + clinical), payment |
| **Session** | Therapy session | type, doctor, patient, date, status, payment info |
| **Package** | Therapy package | name, totalSessions, sessionValue, patient, payment status |
| **Payment** | Financial records | amount, patient, doctor, method, status (paid/pending/partial) |
| **Specialty** | Medical specialties | name, description |

#### Lead Management Models
| Model | Purpose | Key Fields |
|-------|---------|-----------|
| **Leads** | Lead prospects | name, contact, origin, status (novo/atendimento/convertido/perdido), interactions, owner |
| **Followup** | Lead followup | lead, message, status, channel (WhatsApp/phone/email), dateTime |

#### Reporting & Assessment Models
| Model | Purpose | Key Fields |
|-------|---------|-----------|
| **Evolution** | Patient progress notes | patient, doctor, date, observations, treatment progress |
| **MedicalReport** | Medical documentation | patient, type, content, date signed |
| **SchoolReport** | Educational assessment | patient, school info, findings, recommendations |
| **AnamnesisReport** | Initial patient assessment | patient, chief complaint, medical history, medications |
| **MedicalEvent** | Event synchronization | originalId, type (appointment/evolution), timestamp |

#### Payment & Finance Models
| Model | Purpose | Key Fields |
|-------|---------|-----------|
| **Payment** | Transaction records | patient, doctor, amount, method, status, appointment/package ref |
| **Session** | Billable session | status, isPaid, paymentStatus, visualFlag, appointmentId |

#### Administrative Models
| Model | Purpose | Key Fields |
|-------|---------|-----------|
| **User** | Generic user record | name, email, role |
| **Admin** | Admin user | - |
| **Log** | Activity logging | action, user, timestamp, details |
| **Message** | Internal messaging | sender, recipient, content, read status |
| **Contact** | Contact management | name, phone, email |

#### Additional Models
| Model | Purpose |
|-------|---------|
| **ChatContext** | Conversation memory for AI |
| **FollowupAnalytics** | Followup metrics |
| **Metric** | Business metrics |
| **TherapyPackage** | Package template definitions |
| **TherapySession** | Session template |
| **NeuropedAssessment** | Neuropsychological assessment |
| **Prescription** | Medical prescriptions |

### Database Indexes
Key indexes defined on models:
```javascript
// Appointment
- { patient, doctor, date, time } - UNIQUE (prevents duplicate bookings)
- Standard: { status, createdAt }

// Leads
- { status, createdAt }
- { origin, createdAt }
- { createdAt }
- { contact.phone } - sparse unique

// Patient
- { doctor } - for lookups
- Virtual fields: lastAppointment, nextAppointment
```

### Database Relationships
```
Patient ← → Appointment → Doctor
        ← → Package → Session
        ← → Payment
        ← → Evolution

Leads ← → Followup → User (owner)
       ← → interactions[]

Doctor ← → Specialty
        ← → Appointment
        ← → Session
        ← → Payment
```

### Middleware & Hooks
- **Pre-save hooks**: Phone normalization (Leads), appointment validation
- **Post-save hooks**: 
  - Sync events to MedicalEvent (Appointment)
  - Update payment status (Payment → Appointment/Session)
- **Post-update hooks**: Event synchronization via `syncService.js`
- **Virtual fields**: Patient.lastAppointment, Patient.nextAppointment

### Data Synchronization
- **Service**: `services/syncService.js`
- **Purpose**: Keep MedicalEvent collection in sync with Patient/Doctor/Appointment changes
- **Method**: Post-hooks on save/update operations
- **Use Case**: Timeline view, audit trail, reporting

---

## 6. External Integrations

### Payment Processing (PIX - Sicoob)
- **Service**: `services/sicoobService.js`
- **Endpoints**: 
  - OAuth 2.0 authentication
  - PIX key management
  - Webhook handling at `/api/pix/webhook`
- **Features**: Instant payments, webhook notifications
- **Status**: Production environment configured

### WhatsApp Integration
- **Service**: `services/whatsappService.js`, `controllers/whatsappController.js`
- **Features**:
  - Message sending
  - Webhook for incoming messages
  - Followup automation
  - Template messages
- **Events**: Real-time updates via Socket.IO

### Google Integration
- **Google Ads**: `services/google-ads.js`, `routes/google-ads.js`
- **Google Analytics 4**: `@google-analytics/data` package
- **OAuth**: `routes/google-auth.js`

### AI/ML Services
- **OpenAI Integration**: `services/aiAmandaService.js`
- **Features**:
  - Lead qualification (leadIntelligence.js)
  - Intelligent responses (smartFollowup.js)
  - Objection handling (objectionHandler.js)
  - Conversation context (contextMemory.js)

### Email Services
- **SendGrid**: `@sendgrid/mail` package
- **Nodemailer**: Fallback SMTP support
- **Service**: `services/emailService.js`

---

## 7. Queue & Job Processing

### BullMQ Configuration
- **Redis**: Local/VPS connection (127.0.0.1:6379 or configured host)
- **Queue**: `followupQueue`
- **Dashboard**: `/admin/queues` (Bull Board UI)

### Background Jobs
1. **followup.worker.js** - Process followup jobs from queue
2. **followup.cron.js** - Schedule new followup jobs
3. **followup.analytics.cron.js** - Aggregate analytics data
4. **responseTracking.cron.js** - Track response metrics

### Job Processing Flow
```
Schedule (Cron) → Add to Queue (BullMQ) → Worker Process → Update DB/Cache
                                              ↓
                                          Success/Failure → Event Emit
```

---

## 8. Caching Strategy

### Redis Usage
- **Connection**: Local/VPS Redis instance
- **TTL**: Default 300 seconds (configurable)
- **Health Check**: PING every 5 minutes
- **Use Cases**:
  - Session storage
  - BullMQ queue persistence
  - Rate limiting
  - Temporary data caching

### Cache Operations
- Health check: `redis.set('redis_health_check', 'ok', { EX: 10 })`
- Automatic reconnection with exponential backoff

---

## 9. Code Quality Observations

### Strengths
1. **Layered Architecture**: Clear separation of concerns (routes → controllers → services → models)
2. **Comprehensive Models**: Well-defined MongoDB schemas with validation
3. **Error Handling**: Global error handler middleware, try-catch blocks
4. **Security**: JWT auth, Helmet, CORS configuration, bcrypt passwords
5. **Real-time**: Socket.IO for live updates
6. **Async Processing**: BullMQ for background jobs
7. **Database Hooks**: Pre/post-save for maintaining consistency

### Areas for Improvement
1. **Route File Sizes**: 
   - appointment.js (1,397 LOC) - Could be split into multiple files
   - Payment.js (2,107 LOC) - Monolithic, needs refactoring
   - Suggest breaking into: GET/POST/PUT/DELETE logical grouping

2. **Controller Size**: therapyPackageController.js is very large
   - Extract business logic into dedicated service layer

3. **Error Handling**: 
   - Inconsistent error response formats
   - Missing validation error standardization
   - Some endpoints lack proper error handling

4. **Documentation**:
   - Missing JSDoc comments on functions
   - No API documentation (Swagger/OpenAPI)
   - Limited inline comments

5. **Testing**:
   - No test files found (jest/mocha)
   - Should implement unit & integration tests

6. **Logging**:
   - Simple console.log instead of structured logging (Winston available but underutilized)
   - Missing request/response logging middleware

7. **Type Safety**:
   - No TypeScript or JSDoc validation
   - Missing input validation on some endpoints

8. **Database**:
   - No database transaction management
   - Some complex operations could benefit from transactions (Payment distribution)
   - Missing database migration system

---

## 10. Environment Configuration

### Required Environment Variables
```
MONGO_URI              # MongoDB connection string
PORT                   # Express server port (default: 5000)
JWT_SECRET             # JWT signing secret
NODE_ENV               # development|production
REDIS_HOST             # Redis server host
REDIS_PORT             # Redis server port
REDIS_PASSWORD         # Redis authentication password
OPENAI_API_KEY         # OpenAI API key
SICOOB_*               # PIX/Sicoob credentials
SENDGRID_API_KEY       # SendGrid email service
PHONE_NUMBER_ID        # WhatsApp phone number ID
GOOGLE_*               # Google APIs credentials
```

---

## Summary

The Fono-Inova backend is a **sophisticated healthcare/appointment management system** built with:

- **Modern Stack**: Express + MongoDB + Redis + Socket.IO
- **Scalable Architecture**: Asynchronous processing with BullMQ, caching with Redis
- **Rich Features**: Appointments, payments (PIX), WhatsApp integration, AI-powered lead management
- **Real-time Capabilities**: Socket.IO for live updates
- **Multiple Specialties**: Fonoaudiologia, Terapia Ocupacional, Psicologia, Fisioterapia, Pediatria, Neuroped

**Code Quality**: Good architectural foundation but would benefit from modularization, comprehensive testing, and TypeScript adoption.

**Recommended Priorities for Improvement:**
1. Break down large route files (appointment.js, Payment.js)
2. Add comprehensive unit and integration tests
3. Implement TypeScript for type safety
4. Add API documentation (Swagger)
5. Refactor large controllers into service layer
6. Implement structured logging with Winston
7. Add input validation schemas (joi/zod)

