#include <node_api.h>
#include <secp256k1.h>
#include <secp256k1_extrakeys.h>
#include <secp256k1_schnorrsig.h>

typedef struct {
    unsigned char *data;
    size_t size;
} bytes;

static int read_bytes(napi_env env, napi_value value, bytes *out) {
    bool is_typed;
    napi_typedarray_type type;
    void *data;
    if (napi_is_typedarray(env, value, &is_typed) != napi_ok || !is_typed) return 0;
    if (napi_get_typedarray_info(env, value, &type, &out->size, &data, NULL, NULL) != napi_ok ||
        type != napi_uint8_array) return 0;
    out->data = data;
    return 1;
}

static int read_args(napi_env env, napi_callback_info info, bytes *key, bytes *msg, bytes *sig) {
    size_t argc = 3;
    napi_value argv[3];
    return napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc == 3 &&
        read_bytes(env, argv[0], key) && read_bytes(env, argv[1], msg) && read_bytes(env, argv[2], sig);
}

static napi_value boolean(napi_env env, int value) {
    napi_value result;
    if (napi_get_boolean(env, value != 0, &result) != napi_ok) return NULL;
    return result;
}

static napi_value verify_ecdsa(napi_env env, napi_callback_info info) {
    bytes key, msg, sig;
    secp256k1_pubkey pubkey;
    secp256k1_ecdsa_signature parsed;
    const secp256k1_context *ctx = secp256k1_context_static;

    if (!read_args(env, info, &key, &msg, &sig) || (key.size != 33 && key.size != 65) ||
        msg.size != 32 || sig.size != 64) return boolean(env, 0);
    if (!secp256k1_ec_pubkey_parse(ctx, &pubkey, key.data, key.size) ||
        !secp256k1_ecdsa_signature_parse_compact(ctx, &parsed, sig.data)) return boolean(env, 0);
    // libsecp256k1 accepts only low-S at verification; Bitcoin consensus also accepts high-S.
    secp256k1_ecdsa_signature_normalize(ctx, &parsed, &parsed);
    return boolean(env, secp256k1_ecdsa_verify(ctx, &parsed, msg.data, &pubkey));
}

static napi_value verify_schnorr(napi_env env, napi_callback_info info) {
    bytes key, msg, sig;
    secp256k1_xonly_pubkey pubkey;
    const secp256k1_context *ctx = secp256k1_context_static;

    if (!read_args(env, info, &key, &msg, &sig) || key.size != 32 || sig.size != 64 ||
        !secp256k1_xonly_pubkey_parse(ctx, &pubkey, key.data)) return boolean(env, 0);
    return boolean(env, secp256k1_schnorrsig_verify(ctx, sig.data, msg.data, msg.size, &pubkey));
}

NAPI_MODULE_INIT() {
    // Verification uses only libsecp256k1's immutable, thread-safe context.
    secp256k1_selftest();
    const napi_property_descriptor methods[] = {
        { "verifyECDSA", NULL, verify_ecdsa, NULL, NULL, NULL, napi_default, NULL },
        { "verifySchnorr", NULL, verify_schnorr, NULL, NULL, NULL, napi_default, NULL }
    };
    if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
    return exports;
}
