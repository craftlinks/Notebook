
###  Phenotypic Behavior (The "Brain" Approach) ✅ IMPLEMENTED
Currently, the expression *is* the body. Make the expression the *brain*.

**The Change:**
Evaluate A(B) and use the result's **mass** to determine behavior:

**Decision Protocol (mass-based):**
*   Result mass < both A and B: **ATTACK** - A "digested" B, eats it
*   Result mass > A + B/2: **EVADE** - dangerous growth, flee
*   Otherwise: **REPLICATE** - spawn offspring with recombination

**Recombination (maintains diversity):**
- 40%: A(B) result
- 30%: B(A) reverse
- 20%: λx.A(B(x)) composition
- 10%: random SKI mutation

**Anti-monoculture:** Same-species pairs can't attack each other.

**Statistics tracked:**
- `attacks` - predation events
- `evasions` - flight events

**Typical results:** 20-25% diversity maintained, fluctuating species counts.