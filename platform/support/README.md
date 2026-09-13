# Support platform facade

This facade is the future platform boundary for SAC/support. It delegates to
the current `lib/sac*` services and support widget unchanged, preserving all
existing routes, cookies, storage and integrations. Existing callers must not
be moved as part of this structural step.
