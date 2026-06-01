package com.solarized.firedown.manager;

public enum ServiceActions {

    DUMMY(0), AUDIO_ENCODE(1), ENCRYPTION(2), DECRYPTION(3), CANCEL_AUDIO_ENCODE(4), ERROR_AUDIO_ENCODE(5),
    MAKE_GIF(6), CANCEL_MAKE_GIF(7), ERROR_MAKE_GIF(8),
    COMPRESS(9), CANCEL_COMPRESS(10), ERROR_COMPRESS(11),
    EXTRACT(12), CANCEL_EXTRACT(13), ERROR_EXTRACT(14);

    private final int value;

    private ServiceActions(int value) {
        this.value = value;
    }

    public int getValue() {
        return value;
    }

    public static ServiceActions getType(int type){
        for(ServiceActions taskAction : ServiceActions.values()){
            if(taskAction.value == type)
                return taskAction;
        }
        return DUMMY;
    }

}
