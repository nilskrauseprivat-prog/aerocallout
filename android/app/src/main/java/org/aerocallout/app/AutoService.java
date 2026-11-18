package org.aerocallout.app;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/**
 * Android Auto entry point. AeroCallout registers as a navigation app, because only those may draw their own
 * picture on the car display. The picture is a compact traffic display drawn by {@link CarTrafficScreen};
 * all logic and the spoken callouts stay in the app on the phone.
 */
public class AutoService extends CarAppService {

    @NonNull
    @Override
    public HostValidator createHostValidator() {
        // Sideloaded open-source app: accept every host (Android Auto, Desktop Head Unit for testing).
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
    }

    @NonNull
    @Override
    public Session onCreateSession() {
        return new Session() {
            @NonNull
            @Override
            public Screen onCreateScreen(@NonNull Intent intent) {
                return new CarTrafficScreen(getCarContext());
            }
        };
    }
}
