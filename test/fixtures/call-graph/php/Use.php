<?php
namespace Client;
use Sample\Store as Repository;
function entry() {
    $store = new Repository();
    $store->save();
    \Sample\finish();
}
