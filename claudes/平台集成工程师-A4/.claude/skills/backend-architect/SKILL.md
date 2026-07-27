---
name: backend-architect
description: Use this skill for backend engineering tasks including API design, database architecture, microservices patterns, security hardening, performance optimization, and infrastructure decisions. Enforces production-grade practices for scalability, reliability, and maintainability.
---

# Backend Architect

Apply this skill to all backend engineering work.

## Goal

Produce backend systems that are:
- **Scalable**: Handle growth without architectural changes
- **Reliable**: Graceful degradation, fault tolerance, data consistency
- **Secure**: Defense in depth, least privilege, input validation
- **Observable**: Logging, metrics, traces, health checks
- **Maintainable**: Clear boundaries, testability, documentation

---

## Core Principles

### 1. API Design

**RESTful Conventions:**
- Use nouns for resources: `/users`, `/orders`, `/products`
- HTTP methods for actions: GET (read), POST (create), PUT/PATCH (update), DELETE (remove)
- Nest subresources logically: `/users/{id}/orders`
- Version APIs: `/api/v1/` or header-based versioning

**Request/Response Patterns:**
```json
// Success response
{
  "data": { ... },
  "meta": { "page": 1, "total": 100 }
}

// Error response
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [...]
  }
}
```

**Status Codes:**
- 200 OK (successful GET, PUT, PATCH)
- 201 Created (successful POST)
- 204 No Content (successful DELETE)
- 400 Bad Request (validation error)
- 401 Unauthorized (authentication required)
- 403 Forbidden (insufficient permissions)
- 404 Not Found
- 409 Conflict (duplicate resource)
- 422 Unprocessable Entity
- 429 Too Many Requests (rate limited)
- 500 Internal Server Error (unexpected)
- 503 Service Unavailable (temporary)

### 2. Database Architecture

**Choosing the Right Database:**

| Use Case | Recommended |
|----------|-------------|
| Relational data, ACID requirements | PostgreSQL |
| Document storage, flexible schema | MongoDB |
| Key-value cache, sessions | Redis |
| Time-series data | TimescaleDB, InfluxDB |
| Full-text search | Elasticsearch |
| Graph relationships | Neo4j |

**Schema Design Principles:**
- Normalize for consistency (3NF typically sufficient)
- Denormalize for read performance (when justified)
- Use proper indexes (not too many, not too few)
- Plan for migrations from day one
- Use soft deletes for audit trails

**Connection Management:**
- Pool connections (don't create per request)
- Set reasonable timeouts
- Monitor pool utilization
- Handle connection failures gracefully

### 3. Microservices Patterns

**When to Split:**
- Independent deployment velocity needed
- Different scaling requirements
- Distinct failure domains
- Clear bounded contexts

**Service Communication:**

| Pattern | Use When |
|---------|----------|
| Synchronous REST | Simple request/response, low latency needed |
| GraphQL | Flexible data fetching, multiple clients |
| gRPC | Internal services, performance critical |
| Message Queue | Async processing, decoupling, retry handling |
| Event Streaming | Event sourcing, real-time pipelines |

**Circuit Breaker Pattern:**
```
CLOSED → (failure threshold) → OPEN
OPEN → (timeout) → HALF_OPEN
HALF_OPEN → (success) → CLOSED
HALF_OPEN → (failure) → OPEN
```

### 4. Authentication & Authorization

**Authentication Methods:**

| Method | Use Case |
|--------|----------|
| JWT (stateless) | Microservices, mobile apps |
| Session (stateful) | Traditional web apps |
| OAuth 2.0 | Third-party integration |
| API Keys | Server-to-server |

**Security Checklist:**
- [ ] HTTPS everywhere (no exceptions)
- [ ] Hash passwords with bcrypt/argon2 (never MD5/SHA1)
- [ ] Use parameterized queries (prevent SQL injection)
- [ ] Validate and sanitize all input
- [ ] Implement rate limiting
- [ ] Set security headers (HSTS, CSP, X-Frame-Options)
- [ ] Log authentication events
- [ ] Rotate secrets and tokens
- [ ] Use least privilege for service accounts

### 5. Error Handling

**Structured Error Handling:**
```typescript
// Custom error classes
class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number,
    public code: string,
    public isOperational: boolean = true
  ) {
    super(message);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(details: ValidationErrorDetail[]) {
    super('Validation failed', 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

// Global error handler
function errorHandler(err, req, res, next) {
  const status = err.isOperational ? err.statusCode : 500;
  const response = {
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.isOperational ? err.message : 'An unexpected error occurred',
    }
  };
  
  if (err.details) response.error.details = err.details;
  
  // Log non-operational errors
  if (!err.isOperational) {
    logger.error('Unexpected error:', err);
  }
  
  res.status(status).json(response);
}
```

### 6. Logging & Observability

**Structured Logging:**
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "info",
  "service": "user-service",
  "traceId": "abc123",
  "userId": "user-456",
  "action": "user.login",
  "duration": 45,
  "status": "success"
}
```

**Log Levels:**
- ERROR: System failures requiring attention
- WARN: Unexpected but handled situations
- INFO: Business events, state changes
- DEBUG: Detailed diagnostic information

**Health Checks:**
- Liveness: Is the service running?
- Readiness: Can the service handle requests?
- Dependencies: Are critical deps available?

### 7. Performance Optimization

**Caching Strategies:**

| Strategy | Use When |
|----------|----------|
| Cache-Aside | General purpose, read-heavy |
| Write-Through | Strong consistency needed |
| Write-Behind | Write performance critical |

**Query Optimization:**
- Use EXPLAIN ANALYZE
- Create composite indexes for multi-column filters
- Avoid SELECT *
- Paginate large result sets
- Use connection pooling

**Performance Targets:**
- API response: < 200ms (p95)
- Database query: < 50ms (p95)
- Time to first byte: < 100ms

### 8. Testing Backend Systems

**Test Pyramid:**
```
        /\
       /  \      E2E Tests (few)
      /----\
     /      \    Integration Tests (some)
    /--------\
   /          \  Unit Tests (many)
  /------------\
```

**What to Test:**
- Unit: Business logic, validation, transformations
- Integration: Database queries, external services, message queues
- E2E: Critical user journeys

**Test Database:**
- Use a separate test database
- Reset state between tests
- Use transactions for rollback

---

## Common Anti-Patterns

### Do Not

- **Store secrets in code** — Use environment variables or secret managers
- **Ignore connection pooling** — Each connection is expensive
- **N+1 queries** — Eager load relationships
- **Return raw errors** — Sanitize error messages for clients
- **Skip input validation** — Never trust user input
- **Hardcode configuration** — Externalize all config
- **Skip rate limiting** — Protect public endpoints
- **Mix concerns** — Keep controllers thin, services focused
- **Skip tests for "simple" code** — Bugs hide in simplicity
- **Over-engineer for scale** — Build for today's requirements

---

## Decision Framework

### Choosing Architecture

```
Is this a monolith or microservices?
├── Team size < 10 → Start with monolith
├── Independent scaling needed → Microservices
├── Different tech stacks needed → Microservices
└── Otherwise → Monolith with clear boundaries
```

### Choosing Communication

```
Is the operation synchronous or async?
├── User waiting for response → Synchronous
│   ├── Simple CRUD → REST
│   ├── Complex queries → GraphQL
│   └── High performance → gRPC
└── Background processing → Async (Queue/Stream)
```

---

## Checklist Before Deployment

- [ ] All endpoints have authentication
- [ ] Rate limiting on public endpoints
- [ ] Input validation on all inputs
- [ ] Database queries use indexes
- [ ] Error messages don't leak internals
- [ ] Secrets are externalized
- [ ] Logging captures key events
- [ ] Health checks implemented
- [ ] Database backups configured
- [ ] Monitoring and alerting set up
- [ ] Load tested for expected traffic
- [ ] Rollback plan documented
