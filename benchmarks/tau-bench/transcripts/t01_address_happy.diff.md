# Transcript diff: baseline vs jupiter

## Meta

| | baseline | jupiter |
|---|---|---|
| source | bench/baseline | bench/jupiter |
| model | deepseek-chat | deepseek-chat |
| task | t01_address_happy | t01_address_happy |
| startedAt | 2026-04-21T13:21:57.995Z | 2026-04-21T13:22:21.292Z |

## Summary

| metric | baseline | jupiter | delta |
|---|---:|---:|---:|
| model calls | 5 | 6 | +1 |
| user turns | 3 | 3 | 0 |
| tool calls | 2 | 3 | +1 |
| cache hit | 45.9% | 93.9% | **+48.0pp** |
| cost (USD) | $0.001192 | $0.000953 | -20.1% |
| prefix hashes | 0 | 1 | — |

## Turn-by-turn

| turn | kind | baseline tool calls | jupiter tool calls | note |
|---:|:---:|---|---|---|
| 1 | diverge | — | lookup_order | tool calls differ: A=[—] B=[lookup_order] |
| 2 | diverge | lookup_order | lookup_user | tool calls differ: A=[lookup_order] B=[lookup_user] |
| 3 | diverge | update_address | update_address | text similarity 68% |

## First divergence (turn 1)

tool calls differ: A=[—] B=[lookup_order]

**baseline:**

```
I can help you update the shipping address for your order. First, I need to verify your identity. Could you please provide your name and order ID? You've already given me order ID o_1002, but I also need your name to proceed with the address update.
```

**jupiter:**

```
Great! I can see order o_1002 is in "processing" status, which means I can update the shipping address. However, I still need to verify your identity. Could you please provide your name so I can look up your user information using the user ID associated with this order?
```
