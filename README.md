# YT Levelr

A firefox plugin to equalise the volume of youtube videos, especially podcasts, where every producer has their own idea of what the correct levels should be.

## Strategy
- Gain limits widen over time as confidence in the measurement grows
- Cuts are permitted more aggressively than boosts at all stages (asymmetric) because a sudden loud blast is worse than staying quiet for a few seconds
- Gain transitions are faster for cuts than for boosts (asymmetric attack/release)
- After 30s the gain locks; a slow drift correction every 3 minutes handles any remaining long-term level shift
- Samples below the noise floor are ignored to avoid silence skewing the median
