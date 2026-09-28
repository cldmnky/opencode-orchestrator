import { describe, expect, test } from "bun:test"
import { BoundedMap, BOUNDED_MAP_DEFAULT_LIMIT } from "../../src/opencode-v2/bounded-map.js"

describe("BoundedMap", () => {
  test("rejects an invalid limit", () => {
    expect(() => new BoundedMap(0)).toThrow("positive integer")
    expect(() => new BoundedMap(1.5)).toThrow("positive integer")
    expect(new BoundedMap(1).limit).toBe(1)
    expect(BOUNDED_MAP_DEFAULT_LIMIT).toBeGreaterThan(0)
  })

  test("evicts the least-recently-used entry on overflow", () => {
    const map = new BoundedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)
    map.set("c", 3)
    // Touch "a" so "b" becomes the oldest.
    expect(map.get("a")).toBe(1)
    map.set("d", 4)

    expect(map.size).toBe(3)
    expect(map.has("b")).toBe(false)
    expect(map.has("a")).toBe(true)
    expect(map.has("c")).toBe(true)
    expect(map.has("d")).toBe(true)
  })

  test("keeps a protected entry and trims the next unprotected one", () => {
    const map = new BoundedMap<string, number>(2, (key) => key !== "protected")
    map.set("protected", 1)
    map.set("b", 2)
    // "protected" is oldest and protected, so "b" is evicted instead.
    map.set("c", 3)
    expect(map.has("protected")).toBe(true)
    expect(map.has("b")).toBe(false)
    expect(map.has("c")).toBe(true)
  })

  test("may exceed the limit while every entry is protected, then trims", () => {
    let protect = true
    const map = new BoundedMap<string, number>(1, () => !protect)
    map.set("a", 1)
    map.set("b", 2)
    expect(map.size).toBe(2)
    // Once protection lifts, the oldest entry is trimmed on the next insert.
    protect = false
    map.set("c", 3)
    expect(map.size).toBe(1)
    expect(map.has("c")).toBe(true)
  })

  test("set refreshes recency for an existing key and delete removes it", () => {
    const map = new BoundedMap<string, number>(2)
    map.set("a", 1)
    map.set("b", 2)
    map.set("a", 10)
    map.set("c", 3)

    expect(map.get("a")).toBe(10)
    expect(map.has("b")).toBe(false)
    expect(map.delete("a")).toBe(true)
    expect(map.delete("a")).toBe(false)
    expect(map.size).toBe(1)
  })

  test("keys are iterated least-recently-used first", () => {
    const map = new BoundedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)
    map.set("c", 3)
    map.get("a")
    expect([...map.keys()]).toEqual(["b", "c", "a"])
    expect([...map.values()]).toEqual([2, 3, 1])
  })
})
