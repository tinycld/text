# Playwright specs — text

## Deferred specs

### Phase 3b activity tab

End-to-end timing depends on the 60s `editEvents` window close.
Server unit and integration tests
(`server/edit_event_emission_e2e_test.go`) drive the buffer path with
shortened windows; the client hook + tab tests cover rendering. A
Playwright spec waiting 60s+ for the window to close would be flaky
in CI without environment-specific window-shortening, which is not
worth the test-infra complexity for an informational surface.
