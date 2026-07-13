---
name: api-design
description: Use this skill when designing, implementing, or reviewing APIs. Covers RESTful design, GraphQL schemas, gRPC services, API versioning, authentication, pagination, error handling, and documentation. Enforces consistency, security, and developer experience.
---

# API Design

Apply this skill to all API design and implementation work.

## Goal

Produce APIs that are:
- **Consistent**: Uniform patterns across endpoints
- **Secure**: Auth, validation, rate limiting by default
- **Discoverable**: Self-documenting, predictable
- **Evolvable**: Versioned, backward compatible
- **Performant**: Efficient queries, caching, pagination

---

## RESTful API Design

### URL Structure

```
# Collection pattern
GET    /api/v1/users          → List users
POST   /api/v1/users          → Create user
GET    /api/v1/users/:id      → Get user
PUT    /api/v1/users/:id      → Replace user
PATCH  /api/v1/users/:id      → Update user
DELETE /api/v1/users/:id      → Delete user

# Nested resources
GET    /api/v1/users/:id/orders       → List user's orders
POST   /api/v1/users/:id/orders       → Create order for user
GET    /api/v1/users/:id/orders/:oid   → Get specific order

# Actions (when CRUD doesn't fit)
POST   /api/v1/users/:id/activate     → Activate user
POST   /api/v1/users/:id/deactivate   → Deactivate user
POST   /api/v1/orders/:id/cancel      → Cancel order
POST   /api/v1/payments/:id/refund    → Refund payment
```

### URL Rules

- Use plural nouns: `/users` not `/user`
- Use kebab-case: `/user-profiles` not `/userProfiles`
- Nest at most one level: `/users/:id/orders`
- Use query params for filtering: `/users?status=active&role=admin`
- Avoid verbs in URLs: `/users` not `/getUsers`

### HTTP Methods

| Method | Idempotent | Safe | Cacheable |
|--------|-----------|------|-----------|
| GET | Yes | Yes | Yes |
| POST | No | No | Only if fresh |
| PUT | Yes | No | No |
| PATCH | No* | No | No |
| DELETE | Yes | No | No |
| OPTIONS | Yes | Yes | Yes |
| HEAD | Yes | Yes | Yes |

### Request/Response Design

**Create (POST)**
```json
// Request
POST /api/v1/users
{
  "email": "jane@example.com",
  "name": "Jane Doe",
  "role": "engineer"
}

// Response 201
{
  "id": "usr_2kf8d9",
  "email": "jane@example.com",
  "name": "Jane Doe",
  "role": "engineer",
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-15T10:30:00Z"
}
```

**List (GET with pagination)**
```json
// Request
GET /api/v1/users?page=2&per_page=20&sort=created_at&order=desc

// Response 200
{
  "data": [
    { "id": "usr_abc", "email": "...", "name": "..." }
  ],
  "pagination": {
    "page": 2,
    "per_page": 20,
    "total": 150,
    "total_pages": 8
  }
}
```

**Error Response**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "email",
        "message": "Invalid email format"
      }
    ]
  }
}
```

### Pagination Strategies

| Strategy | Use When | Pros | Cons |
|----------|----------|------|------|
| Offset | Simple lists | Easy, page jumping | Slow for deep pages |
| Cursor | Large datasets | Consistent, fast | No page jumping |
| Keyset | Time-ordered | Fast, consistent | Limited sort options |

**Cursor Pagination:**
```
GET /api/v1/users?cursor=eyJpZCI6MTAwfQ&limit=20

{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6MTIwfQ",
    "prev_cursor": "eyJpZCI6ODB9",
    "has_more": true
  }
}
```

### Filtering & Sorting

```
# Exact match
GET /users?status=active

# Comparison
GET /users?created_after=2025-01-01
GET /users?age_gt=25

# Multi-value
GET /users?role=admin&role=engineer

# Sort
GET /users?sort=-created_at,name  # - = desc

# Field selection
GET /users?fields=id,name,email

# Search
GET /users?q=jane&search_fields=name,email
```

---

## GraphQL Design

### Schema Principles

```graphql
# Use singular type names
type User {
  id: ID!
  email: String!
  name: String!
  role: UserRole!
  orders(first: Int, after: String): OrderConnection!
  createdAt: DateTime!
}

# Use Connections for lists
type OrderConnection {
  edges: [OrderEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

# Use enums for fixed values
enum UserRole {
  ADMIN
  ENGINEER
  MANAGER
}

# Mutations use input types
input CreateUserInput {
  email: String!
  name: String!
  role: UserRole! = ENGINEER
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): DeleteResult!
}
```

### GraphQL Rules

- Use `ID!` for identifiers
- Use Connections (Relay spec) for lists
- Separate Input types from Output types
- Provide meaningful error codes in extensions
- Set query depth and complexity limits
- Use DataLoader to prevent N+1

---

## gRPC Design

### Service Definition

```protobuf
syntax = "proto3";

package users.v1;

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (stream ListUsersResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc UpdateUser(UpdateUserRequest) returns (UpdateUserResponse);
  rpc DeleteUser(DeleteUserRequest) returns (DeleteUserResponse);
}

message GetUserRequest {
  string id = 1;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
  string filter = 3;
}

message User {
  string id = 1;
  string email = 2;
  string name = 3;
  string role = 4;
  int64 created_at = 5;  // Unix timestamp
}
```

### gRPC Rules

- Use proto3 syntax
- Use plural service names
- Version packages: `users.v1`
- Use field numbers 1-15 for frequently used fields
- Use streaming for large result sets
- Generate both server and client stubs

---

## Authentication

### API Key
```
# Header
Authorization: Bearer sk_live_abc123

# Or custom header
X-API-Key: sk_live_abc123
```

### JWT
```
# Header
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

# Structure
Header.Payload.Signature

# Claims
{
  "sub": "usr_2kf8d9",
  "role": "admin",
  "iat": 1705312200,
  "exp": 1705315800
}
```

### OAuth 2.0

```
# Authorization Code Flow
1. Client → Auth server (authorize)
2. User authenticates
3. Auth server → Client (code)
4. Client → Auth server (token exchange)
5. Auth server → Client (access_token)
6. Client → Resource server (access_token)

# Scopes
read:users    - Read user data
write:users   - Modify user data
admin:users   - Full user management
```

---

## Rate Limiting

```
# Headers
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705315800

# Response when limited (429)
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 60 seconds.",
    "retry_after": 60
  }
}
```

---

## Versioning

| Strategy | How | Pros | Cons |
|----------|-----|------|------|
| URL path | `/api/v1/users` | Simple, visible | URL changes |
| Header | `Accept: application/vnd.api.v1+json` | Clean URLs | Hidden |
| Query param | `/users?version=1` | Simple | Not RESTful |

**Rules:**
- Never break backward compatibility within a version
- Deprecation: 6+ months notice, Sunset header
- Support at most 2 versions simultaneously

---

## Documentation

**OpenAPI 3.0 spec:**
- Document every endpoint
- Include request/response examples
- Document error codes
- Specify auth requirements
- Keep spec and code in sync

**Developer Experience:**
- Interactive docs (Swagger UI)
- SDKs for popular languages
- Rate limit visibility
- Webhook documentation
- Changelog

---

## Anti-Patterns

### Do Not

- **Return 200 for errors** — Use proper HTTP status codes
- **Expose internal IDs** — Use public-facing identifiers
- **Skip pagination** — Always paginate list endpoints
- **Accept unvalidated input** — Validate everything
- **Use verbs in URLs** — Use nouns + HTTP methods
- **Version via query params** — Use URL path or header
- **Return different shapes** — Consistent response envelope
- **Ignore caching headers** — Set ETag, Cache-Control
- **Skip CORS configuration** — Configure explicitly
- **Store secrets in URLs** — Use headers or body