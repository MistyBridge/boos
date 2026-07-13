---
name: system-design
description: Use this skill for system design interviews, architecture planning, and technical decision-making. Covers distributed systems, scalability patterns, consistency models, load balancing, caching strategies, and capacity planning. Provides structured approach to designing complex systems.
---

# System Design

Apply this skill when designing complex systems, preparing for system design interviews, or making architectural decisions.

## Goal

Produce system designs that are:
- **Feasible**: Works within constraints
- **Scalable**: Handles growth predictably
- **Reliable**: Maintains availability and durability
- **Cost-effective**: Optimizes resource utilization
- **Simple**: Minimizes unnecessary complexity

---

## System Design Framework

### Step 1: Clarify Requirements

**Ask Questions:**
- What are the functional requirements?
- What are the non-functional requirements?
- How many users? What growth rate?
- What's the read/write ratio?
- What latency is acceptable?
- What consistency level is required?
- What availability target?

**Example Requirements Matrix:**
| Requirement | Target |
|-------------|--------|
| Users | 10M daily active |
| Requests | 100K QPS |
| Latency | < 200ms p99 |
| Availability | 99.9% |
| Data | 5TB, growing 1TB/year |
| Read:Write | 100:1 |

### Step 2: Define Capacity

**Traffic Estimation:**
```
Daily Active Users: 10M
Requests per user: 20/day
Daily requests: 200M
Peak QPS = Daily requests / Peak hours / 60 / 60 × Peak factor
         = 200M / 4 / 60 / 60 × 2
         = ~28K QPS (average peak)
         
For 100K QPS target: need ~3-4x capacity margin
```

**Storage Estimation:**
```
Per record: 500 bytes
Records per day: 1M
Daily growth: 500MB
5 years: ~900GB
With replication (3x): ~2.7TB
```

**Bandwidth Estimation:**
```
Avg request size: 10KB
Peak QPS: 100K
Bandwidth = 100K × 10KB = 1GB/s = 8Gbps
```

### Step 3: Create High-Level Design

**Core Components:**
```
Client → Load Balancer → API Servers → Services → Database
                     ↓
                   Cache
```

**Draw the Diagram:**
1. Clients (web, mobile, API)
2. Load balancers (DNS → L7)
3. API gateway / web servers
4. Service layer (microservices if needed)
5. Data layer (databases, caches, queues)
6. External integrations

### Step 4: Deep Dive Components

#### Load Balancing

**Strategies:**
| Strategy | Use When |
|----------|----------|
| Round Robin | Equal server capacity |
| Least Connections | Long-lived connections |
| Weighted | Different server capacities |
| IP Hash | Sticky sessions needed |
| Latency-aware | Geographic distribution |

**Health Checks:**
- Active: Periodic HTTP checks
- Passive: Monitor actual requests

**Where to Place LB:**
- Between users and web servers
- Between web servers and services
- Between services and databases (if supported)

#### Database Selection

**Relational vs NoSQL:**

| Factor | SQL | NoSQL |
|--------|-----|-------|
| Data structure | Fixed schema | Flexible schema |
| Relationships | Complex joins | Simple/no joins |
| Transactions | ACID | Often limited |
| Scale | Vertical primary | Horizontal primary |
| Query patterns | Complex queries | Simple lookups |

**Polyglot Persistence:**
```
Primary data → PostgreSQL (transactions, relationships)
Session cache → Redis (fast key-value)
Search → Elasticsearch (full-text, faceted)
Analytics → ClickHouse (time-series aggregations)
Blob storage → S3 (large files, CDN)
```

#### Caching

**Where to Cache:**
```
Client caching (browser, mobile app)
CDN (static assets, API responses)
Load balancer (SSL termination, simple cache)
App server (in-memory, local cache)
Distributed cache (Redis, Memcached)
Database (query cache, buffer pool)
```

**Cache Strategies:**
| Strategy | Description | Trade-off |
|----------|-------------|-----------|
| Cache-Aside | App manages cache | Most common, eventual consistency |
| Write-Through | Write to cache then DB | Strong consistency, write latency |
| Write-Behind | Write to cache, async to DB | Low write latency, data loss risk |
| Refresh-Ahead | Pre-populate before expiry | Smooth reads, wasted refreshes |

**Cache Eviction:**
- LRU: Least recently used (default choice)
- LFU: Least frequently used (hot data)
- FIFO: Simple but ineffective
- TTL: Time-based expiry

#### Message Queues

**Use Cases:**
- Async processing
- Decoupling services
- Buffering load spikes
- Retry handling
- Event broadcasting

**Queue Selection:**
| Queue | Strengths |
|-------|-----------|
| RabbitMQ | Flexible routing, reliability |
| Kafka | High throughput, replay, streaming |
| Redis Streams | Simple, low latency |
| SQS | Managed, infinite scale |

**Producer-Consumer Patterns:**
```
Single producer, single consumer → Simple queue
Multiple producers, single consumer → Work queue
Single producer, multiple consumers → Pub/Sub
Multiple producers, multiple consumers → Topics with partitions
```

#### Consistency Models

| Model | Description | Use Case |
|-------|-------------|----------|
| Strong | All reads see latest write | Financial transactions |
| Eventual | Reads may see stale data | Social feeds, analytics |
| Causal | Related writes ordered | Collaborative editing |
| Read-your-writes | User sees own writes | User profile updates |

**CAP Theorem:**
- CP: Consistency + Partition tolerance (banking)
- AP: Availability + Partition tolerance (social media)
- CA: Not practical in distributed systems

**Conflict Resolution:**
- Last-write-wins (with timestamps)
- Version vectors (detect concurrent writes)
- CRDTs (merge without conflict)
- Application-level resolution

#### Sharding

**Sharding Strategies:**

| Strategy | Pros | Cons |
|----------|------|------|
| Hash-based | Even distribution | Can't range query |
| Range-based | Range queries | Hot spots |
| Directory | Flexible | Lookup overhead |

**Handling Hot Partitions:**
- Split hot partition
- Use composite keys
- Apply caching layer
- Rebalance periodically

**Cross-Shard Queries:**
- Avoid when possible
- Use scatter-gather (parallel queries)
- Consider duplicate data for read optimization

### Step 5: Address Bottlenecks

**Common Bottlenecks:**

| Bottleneck | Solution |
|------------|----------|
| Single DB server | Replication, sharding |
| Hot partition | Split, rekey, cache |
| Network bandwidth | Compression, CDN |
| Lock contention | Optimistic locking, queue |
| GC pauses | Tune GC, use languages without GC |
| SSL overhead | Session tickets, hardware acceleration |

### Step 6: Design for Failure

**Failure Modes:**
- Hardware failure (disk, network, power)
- Software failure (bugs, deadlocks)
- Human error (bad deployment, config)
- External failure (API, network)
- Attack (DDoS, injection)

**Mitigation Strategies:**

| Strategy | Implementation |
|----------|---------------|
| Redundancy | Multiple instances, cross-region |
| Failover | Active-passive, active-active |
| Graceful degradation | Feature flags, fallback paths |
| Rate limiting | Token bucket, sliding window |
| Circuit breaker | Hystrix, resilience4j |

**MTTR vs MTBF:**
- MTBF (Mean Time Between Failures): Prevent failures
- MTTR (Mean Time To Recovery): Recover quickly
- Focus on reducing MTTR; complex systems always fail

---

## Common System Design Patterns

### URL Shortener (TinyURL)

**Requirements:**
- Shorten URLs, redirect to original
- 100M URLs/month, 10 year retention
- Custom aliases, analytics

**Design:**
```
Hash function:
- MD5/SHA → first 7 chars (collision handling needed)
- Or: Pre-generate random keys, store unused

Storage:
- Key → Original URL mapping
- Analytics: Clicks, timestamp, referrer, geo

Approach:
1. Check if URL exists (return if yes)
2. Generate key, check collision
3. Store in DB + cache
4. Return short URL

Redirect: 301 (permanent) or 302 (temporary + analytics)
```

### Rate Limiter

**Algorithms:**

| Algorithm | Description |
|-----------|-------------|
| Fixed Window | Count requests in time window |
| Sliding Window Log | Store timestamps, count in range |
| Sliding Window Counter | Approximate with weighted windows |
| Token Bucket | Tokens refill, consume on request |

**Implementation:**
```
Redis-based:
- Key: user_id:endpoint
- Value: token count
- Lua script: atomic check-and-decrement

Rules:
- 100 requests per minute per user
- 1000 requests per hour globally
```

### Chat System (WhatsApp-like)

**Requirements:**
- 1:1 and group chat
- Real-time delivery
- Offline messages
- Media attachments

**Design:**
```
Connection: WebSocket for real-time
Fallback: Long polling

Message Flow:
1. Sender → Message server → Queue
2. Queue → Recipient (if online)
3. Store in DB (if offline)
4. Push notification (offline user)

Storage:
- Messages: Partitioned by conversation_id
- User state: Redis (online/offline)
- Media: S3 + CDN

Groups:
- Fan-out to all members
- Or: Shared conversation with member list
```

### News Feed (Twitter-like)

**Requirements:**
- Follow users, see their posts
- Timeline sorted by time
- 300M users, 500 posts/day average

**Two Approaches:**

**Pull (Read-time):**
```
User requests feed:
1. Get following list
2. Query posts from each
3. Merge, sort, paginate
Pros: Simple, no extra storage
Cons: Slow for many follows
```

**Push (Write-time):**
```
User posts:
1. Write to posts table
2. Push to all followers' feed tables
Pros: Fast reads
Cons: Celebrity problem (fan-out explosion)
```

**Hybrid:**
``- Regular users: Push to followers' feeds
- Celebrities: Pull from their posts
- Pre-compute for regular, merge celeb at read
```

---

## Estimation Cheat Sheet

| Resource | Approximate Capacity |
|----------|---------------------|
| Single server | 1K-10K QPS |
| Load balancer | 100K+ connections |
| Cache hit ratio target | 80-95% |
| SSD IOPS | 10K-100K |
| Network bandwidth | 1-10 Gbps |
| DB query latency | 1-50ms |
| API latency target | < 100ms |
| Storage per server | 1-100 TB |

---

## Interview Tips

1. **Think out loud** — Share your reasoning
2. **Start simple** — Add complexity when needed
3. **Know your numbers** — Estimates matter
4. **Discuss trade-offs** — No perfect solution
5. **Draw diagrams** — Visualize architecture
6. **Handle edge cases** — Think about failures
7. **Ask about constraints** — Clarify early
8. **Time management** — Don't deep dive too early

---

## Checklist

- [ ] Requirements clarified
- [ ] Capacity estimated
- [ ] High-level diagram drawn
- [ ] Key components explained
- [ ] Trade-offs discussed
- [ ] Bottlenecks identified
- [ ] Failure modes addressed
- [ ] Scaling path outlined