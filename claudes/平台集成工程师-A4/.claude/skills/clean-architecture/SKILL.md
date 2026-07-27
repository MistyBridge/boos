---
name: clean-architecture
description: Use this skill for software architecture decisions, applying Clean Architecture, Hexagonal Architecture, and Domain-Driven Design principles. Covers layering, dependency inversion, bounded contexts, domain modeling, and maintainability patterns. Enforces separation of concerns and testability.
---

# Clean Architecture

Apply this skill when designing or reviewing software architecture.

## Goal

Produce architectures that are:
- **Testable**: Business logic without external dependencies
- **Maintainable**: Clear boundaries, easy to locate code
- **Independent**: Framework, database, UI are details
- **Flexible**: Easy to swap implementations
- **Evolutionary**: Grows without rewrites

---

## Core Principles

### Dependency Rule

```
Dependencies only point inward:

┌─────────────────────────────────────────────┐
│                Frameworks                   │
│   ┌─────────────────────────────────────┐   │
│   │          Interface Adapters         │   │
│   │   ┌─────────────────────────────┐   │   │
│   │   │       Use Cases              │   │   │
│   │   │   ┌─────────────────────┐   │   │   │
│   │   │   │    Entities/Domain  │   │   │   │
│   │   │   │                     │   │   │   │
│   │   │   └─────────────────────┘   │   │   │
│   │   │           ↑                 │   │   │
│   │   └───────────│─────────────────┘   │   │
│   └───────────────│─────────────────────┘   │
└────────────────────│────────────────────────┘
                     │
         Dependencies flow inward only
```

**Source code dependencies must only point inward.**

---

## Architecture Layers

### Domain Layer (Entities)

Core business rules, no dependencies.

```typescript
// domain/entities/User.ts
export class User {
  private constructor(
    public readonly id: string,
    public email: string,
    public name: string,
    public status: UserStatus,
    private _createdAt: Date
  ) {}

  static create(email: string, name: string): User {
    if (!email.includes('@')) throw new InvalidEmailError(email);
    if (name.length < 2) throw new InvalidNameError(name);
    
    return new User(
      crypto.randomUUID(),
      email,
      name,
      UserStatus.ACTIVE,
      new Date()
    );
  }

  changeEmail(newEmail: string): void {
    if (!newEmail.includes('@')) throw new InvalidEmailError(newEmail);
    this.email = newEmail;
  }

  suspend(): void {
    if (this.status === UserStatus.SUSPENDED) {
      throw new AlreadySuspendedError(this.id);
    }
    this.status = UserStatus.SUSPENDED;
  }

  activate(): void {
    this.status = UserStatus.ACTIVE;
  }
}

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted'
}
```

### Domain Value Objects

Immutable, validated by construction.

```typescript
// domain/value-objects/Email.ts
export class Email {
  private constructor(public readonly value: string) {}

  static from(email: string): Email {
    const trimmed = email.trim().toLowerCase();
    if (!this.isValid(trimmed)) {
      throw new InvalidEmailError(email);
    }
    return new Email(trimmed);
  }

  private static isValid(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}
```

### Domain Repository Interfaces

Ports, not implementations.

```typescript
// domain/repositories/IUserRepository.ts
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  findAll(criteria: UserSearchCriteria): Promise<PaginatedResult<User>>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}
```

### Use Case Layer (Application)

Orchestrates business flows.

```typescript
// application/use-cases/CreateUserUseCase.ts
export interface CreateUserRequest {
  email: string;
  name: string;
}

export interface CreateUserResponse {
  id: string;
  email: string;
  name: string;
}

export class CreateUserUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly emailService: IEmailService,
    private readonly logger: ILogger
  ) {}

  async execute(request: CreateUserRequest): Promise<CreateUserResponse> {
    const email = Email.from(request.email);
    
    // Check uniqueness
    const existing = await this.userRepo.findByEmail(email);
    if (existing) throw new UserAlreadyExistsError(request.email);

    // Create domain entity
    const user = User.create(email.value, request.name);
    
    // Persist
    await this.userRepo.save(user);
    
    // Side effect
    await this.emailService.sendWelcomeEmail(email);
    
    this.logger.info('User created', { userId: user.id });

    return {
      id: user.id,
      email: user.email,
      name: user.name
    };
  }
}
```

### Interface Adapters Layer

Converts data between formats.

```typescript
// infrastructure/controllers/UserController.ts
export class UserController {
  constructor(private readonly createUser: CreateUserUseCase) {}

  async create(request: Request, response: Response): Promise<void> {
    try {
      const result = await this.createUser.execute({
        email: request.body.email,
        name: request.body.name
      });
      response.status(201).json(result);
    } catch (error) {
      this.handleError(response, error);
    }
  }

  private handleError(response: Response, error: unknown): void {
    if (error instanceof InvalidEmailError) {
      response.status(400).json({ error: 'Invalid email format' });
    } else if (error instanceof UserAlreadyExistsError) {
      response.status(409).json({ error: 'User already exists' });
    } else {
      response.status(500).json({ error: 'Internal server error' });
    }
  }
}
```

### Repository Implementation

Infrastructure detail, implements domain interface.

```typescript
// infrastructure/persistence/PostgresUserRepository.ts
export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.db.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    
    if (!result.rows[0]) return null;
    
    return this.toDomain(result.rows[0]);
  }

  async save(user: User): Promise<void> {
    const data = this.toData(user);
    await this.db.query(
      `INSERT INTO users (id, email, name, status, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = $2, name = $3, status = $4`,
      [data.id, data.email, data.name, data.status, data.createdAt]
    );
  }

  private toDomain(row: UserRow): User {
    // Reconstitute domain entity from persistence
    return User.reconstitute(
      row.id,
      row.email,
      row.name,
      row.status,
      row.created_at
    );
  }

  private toData(user: User): UserData {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      createdAt: user.createdAt
    };
  }
}
```

---

## Hexagonal Architecture (Ports & Adapters)

```
                   ┌──────────────────────────────┐
                   │          Adapters            │
                   │  ┌────────┐      ┌─────────┐  │
   HTTP Request ───┼──│ Primary│      │Secondary│──┼─── Database
                   │  │Adapter │      │ Adapter │  │
                   │  └────┬───┘      └────┬────┘  │
                   │       │              │       │
                   └───────│──────────────│───────┘
                           │              │
                           ▼              ▼
                   ┌──────────────────────────────┐
                   │           Port               │
                   │    ┌─────────────────┐      │
                   │    │  Application    │      │
                   │    │    Services     │      │
                   │    └────────┬────────┘      │
                   │             │              │
                   │    ┌────────▼────────┐      │
                   │    │     Domain      │      │
                   │    │                 │      │
                   │    └─────────────────┘      │
                   └──────────────────────────────┘

Primary Ports: Called by outside (Use Case interfaces)
Secondary Ports: Called by application (Repository interfaces)
Primary Adapters: Controllers, CLI, Message handlers
Secondary Adapters: Databases, APIs, File systems
```

---

## Domain-Driven Design

### Bounded Contexts

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Sales        │     │   Inventory     │     │   Shipping      │
│    Context      │     │   Context       │     │   Context       │
│                 │     │                 │     │                 │
│  Order          │     │  Product        │     │  Shipment       │
│  Customer       │     │  Stock          │     │  Tracking       │
│  Price          │     │  Warehouse      │     │  Address        │
│                 │     │                 │     │                 │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │   Domain Events       │                       │
         │   ───────────────────>│                       │
         │   OrderCreated        │                       │
         │                       │                       │
         │                       │   StockReserved      │
         │                       │   ───────────────────>│
```

### Aggregates

```typescript
// domain/aggregates/Order.ts
export class Order extends AggregateRoot<OrderId> {
  private constructor(
    id: OrderId,
    private customerId: CustomerId,
    private lines: OrderLine[],
    private status: OrderStatus,
    private total: Money
  ) {
    super(id);
  }

  static create(customerId: CustomerId): Order {
    const order = new Order(
      OrderId.generate(),
      customerId,
      [],
      OrderStatus.DRAFT,
      Money.zero()
    );
    order.addDomainEvent(new OrderCreatedEvent(order.id));
    return order;
  }

  addProduct(product: Product, quantity: number): void {
    if (this.status !== OrderStatus.DRAFT) {
      throw new OrderNotEditableError(this.id);
    }
    
    const line = OrderLine.create(product, quantity);
    this.lines.push(line);
    this.recalculateTotal();
  }

  submit(): void {
    if (this.lines.length === 0) {
      throw new EmptyOrderError(this.id);
    }
    
    this.status = OrderStatus.SUBMITTED;
    this.addDomainEvent(new OrderSubmittedEvent(this.id, this.total));
  }

  private recalculateTotal(): void {
    this.total = this.lines.reduce(
      (sum, line) => sum.add(line.total),
      Money.zero()
    );
  }
}
```

---

## Project Structure

```
src/
├── domain/                    # Domain layer
│   ├── entities/
│   ├── value-objects/
│   ├── aggregates/
│   ├── repositories/         # Interfaces only
│   ├── services/             # Domain services
│   └── events/
├── application/              # Application layer
│   ├── use-cases/
│   ├── ports/                # Application ports
│   └── services/
├── infrastructure/           # Infrastructure layer
│   ├── persistence/
│   │   ├── repositories/     # Repository implementations
│   │   └── models/           # ORM entities
│   ├── adapters/
│   │   ├── controllers/
│   │   └── presenters/
│   ├── services/             # External services
│   └── config/
└── interfaces/               # Framework adapters
    ├── http/
    │   ├── routes/
    │   └── middleware/
    └── cli/
```

---

## Testing Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                         Test Pyramid                             │
│                                                                  │
│                         ┌────────┐                               │
│                        /   E2E    \                              │
│                       /───────────\                             │
│                      / Integration \                            │
│                     /───────────────\                           │
│                    /    Unit Tests    \                         │
│                   /─────────────────────\                        │
│                  /   Domain Unit Tests   \                       │
│                 /─────────────────────────\                      │
└─────────────────────────────────────────────────────────────────┘

Domain Unit Tests: Pure business logic, no mocks needed
Application Unit Tests: Mock repositories/external services
Integration Tests: Real database, real infrastructure
E2E Tests: Full stack through API
```

```typescript
// Domain tests - pure, no mocks
describe('User', () => {
  it('should not allow invalid email', () => {
    expect(() => User.create('invalid', 'John'))
      .toThrow(InvalidEmailError);
  });

  it('should suspend active user', () => {
    const user = User.create('john@example.com', 'John');
    user.suspend();
    expect(user.status).toBe(UserStatus.SUSPENDED);
  });
});

// Use case tests - mock repositories
describe('CreateUserUseCase', () => {
  it('should create user and send email', async () => {
    const userRepo = mock<IUserRepository>();
    const emailService = mock<IEmailService>();
    
    userRepo.findByEmail.mockResolvedValue(null);
    userRepo.save.mockResolvedValue(undefined);
    emailService.sendWelcomeEmail.mockResolvedValue(undefined);

    const useCase = new CreateUserUseCase(userRepo, emailService);
    const result = await useCase.execute({ email: 'a@b.com', name: 'Test' });

    expect(result.id).toBeDefined();
    expect(emailService.sendWelcomeEmail).toHaveBeenCalled();
  });
});
```

---

## Anti-Patterns

### Do Not

- **Reference infrastructure from domain** — Domain is pure
- **Put business logic in controllers** — Controllers route, they don't compute
- **Bypass repository with raw SQL** — All persistence goes through repository
- **Leak persistence models** — Return domain entities, not ORM entities
- **Create god services** — Use case per action, not one service for all
- **Skip the domain layer** — Business logic needs a home
- **Tight-couple to frameworks** — Framework is a detail
- **Ignore bounded contexts** — One model doesn't fit all