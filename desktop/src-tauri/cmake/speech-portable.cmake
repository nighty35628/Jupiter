set(GGML_NATIVE OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_AVX OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_AVX2 OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_AVX512 OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_AVX_VNNI OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_FMA OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_F16C OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_SSE42 OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_BMI2 OFF CACHE BOOL "Portable Jupiter speech" FORCE)
set(GGML_CPU_KLEIDIAI OFF CACHE BOOL "No build-time network fetch" FORCE)
if(APPLE)
    # The binding always links ggml-blas on macOS. Keep its legacy LP64 ABI:
    # Accelerate's $NEWLAPACK/$ILP64 symbols require macOS 13.3. Compile options
    # follow target definitions, so these undefine ggml's new-ABI macros.
    add_compile_options(-UACCELERATE_NEW_LAPACK -UACCELERATE_LAPACK_ILP64)
endif()
